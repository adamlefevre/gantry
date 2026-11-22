import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Env } from "./TaskCoordinator";
import {
  GANTRY_CONFIG_PATH,
  parseGantryConfig,
  verificationFor,
  type GantryConfig,
  type Verification
} from "./gantryConfig";
import rawAgentConfig from "../agent-config.json";
import {
  fillTemplate,
  resolveAgentConfig,
  type AgentConfig,
  type Effort,
  type ResolvedAgentConfig
} from "./agentConfig";
import { prepareEditArguments } from "./tools/editMatching";
import { DEFAULT_READ_LIMIT, FileTools, MAX_LINE_LENGTH } from "./tools/fileTools";

/** The checked-in default model and effort; agent-config.json is the source, these are for reference. */
export const DEFAULT_MODEL = rawAgentConfig.model;
export const DEFAULT_EFFORT = rawAgentConfig.effort as Effort;
export type { Effort };
/**
 * Models that take server-side refusal fallbacks. When one of them declines a turn, the API
 * re-runs it on a fallback model it picks by the refusal's category, inside the same call.
 */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-fable-5-2"]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/**
 * The patch the agent sees from getDiff and the factory keeps at the end. A plain `git diff`
 * leaves out files the agent created (they're untracked), so new tests and modules would be
 * missing from the patch. `git add --intent-to-add` makes them show up as new files.
 */
export const DIFF_COMMAND = "git add --all --intent-to-add && git diff";

/** Model turns per task in the checked-in config. */
export const MAX_AGENT_STEPS = rawAgentConfig.budgets.maxTurns;

interface ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

function tail(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? `[...${s.length - max} chars truncated]\n` + s.slice(-max) : s;
}

export interface StepAudit {
  stepIndex: number;
  toolName: string;
  input: Record<string, unknown>;
  output: unknown;
}

export interface AgentTelemetry {
  taskId: string;
  model: string;
  /** Effort level the run asked for. */
  effort: Effort;
  /** `version` from agent-config.json. */
  agentConfigVersion: string;
  /** Hash of the config the run used, after the GANTRY_MODEL and GANTRY_EFFORT overrides. */
  agentConfigHash: string;
  totalTokens: number;
  stepsCount: number;
  patch: string;
  /** Whether the run can be verified: no `test:` in .gantry.yml means unverified (draft PR only). */
  verification: Verification;
  testCommand: string | null;
  completedAt: string;
}

export interface RepoTarget {
  url: string;
  ref: string;
}

export interface AgentLoopOptions {
  env: Env;
  prompt: string;
  taskId: string;
  /** Repo the sandbox clones before the agent starts. */
  repo?: RepoTarget;
  onStep: (step: StepAudit) => void;
  onChunk: (chunk: string) => void;
  /**
   * A config to run instead of agent-config.json, in the same shape. For tests and for replaying
   * tasks against a candidate config; the GANTRY_MODEL and GANTRY_EFFORT overrides still apply.
   */
  agentConfig?: unknown;
  /** Called once the agent config is resolved, before the sandbox starts. */
  onAgentConfig?: (resolved: ResolvedAgentConfig) => void;
  /** Called once .gantry.yml has been read, before setup runs. */
  onConfig?: (config: GantryConfig, verification: Verification) => void;
}

/** A tool the model can call: its definition, the schema its input must pass, and its body. */
interface AgentTool {
  definition: Anthropic.Beta.BetaTool;
  schema: z.ZodType<any>;
  run: (input: any) => Promise<unknown>;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentTelemetry> {
  const { env, prompt, taskId, repo, onStep, onConfig, onAgentConfig } = options;

  const resolved = await resolveAgentConfig(
    { model: env.GANTRY_MODEL, effort: env.GANTRY_EFFORT },
    options.agentConfig ?? rawAgentConfig
  );
  const agentConfig = resolved.config;
  const { budgets } = agentConfig;
  onAgentConfig?.(resolved);

  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    // Unset in production; the tests point it at the mock Anthropic server.
    baseURL: env.ANTHROPIC_BASE_URL || undefined
  });
  const modelId = agentConfig.model;
  const effort = agentConfig.effort;

  // 1. Initialize Modal Sandbox session
  const initRes = await fetch(`${env.MODAL_SANDBOX_URL}/session/create`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.AGENT_SANDBOX_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ taskId, repo_url: repo?.url, ref: repo?.ref })
  });

  if (!initRes.ok) {
    throw new Error(`Failed to initialize Modal Sandbox: ${await initRes.text()}`);
  }

  const initData = (await initRes.json()) as { sessionId?: string; sandbox_id?: string };
  const sessionId = initData.sessionId || initData.sandbox_id || "";

  const callSandbox = async (endpoint: string, payload: Record<string, unknown>) => {
    const res = await fetch(`${env.MODAL_SANDBOX_URL}${endpoint}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.AGENT_SANDBOX_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sessionId, sandbox_id: sessionId, ...payload })
    });
    if (!res.ok) {
      throw new Error(`Sandbox API error [${endpoint}]: ${await res.text()}`);
    }
    return res.json();
  };

  /** POST /file/read; null when the file doesn't exist (the service answers 404). */
  const readSandboxFile = async (path: string): Promise<{ content: string; truncated: boolean } | null> => {
    const res = await fetch(`${env.MODAL_SANDBOX_URL}/file/read`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.AGENT_SANDBOX_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sessionId, sandbox_id: sessionId, path })
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Sandbox API error [/file/read]: ${await res.text()}`);
    const data = (await res.json()) as { content?: string; truncated?: boolean };
    return { content: data.content ?? "", truncated: data.truncated === true };
  };
  const readOptionalFile = async (path: string) => (await readSandboxFile(path))?.content ?? null;

  const fileTools = new FileTools({
    read: readSandboxFile,
    write: async (path, content) => {
      await callSandbox("/file/write", { path, content });
    }
  });

  /**
   * Runs a tool body, records the step, and hands errors back to the model as `{error}`, so a
   * bad path or a stale edit is something the model can fix rather than the end of the task.
   */
  const audited = async <T>(toolName: string, input: Record<string, unknown>, run: () => Promise<T>) => {
    let output: T | { error: string };
    try {
      output = await run();
    } catch (e) {
      output = { error: e instanceof Error ? e.message : String(e) };
    }
    onStep({ stepIndex: ++stepCounter, toolName, input, output });
    return output;
  };

  let stepCounter = 0;

  try {
    // 2. Read .gantry.yml (only a cloned repo has one) and run its setup commands.
    const config = parseGantryConfig(repo ? await readOptionalFile(GANTRY_CONFIG_PATH) : null);
    const verification = verificationFor(config);
    onConfig?.(config, verification);

    for (const command of config.setup) {
      const data = (await callSandbox("/exec", {
        command,
        timeout_seconds: budgets.setupTimeoutSeconds
      })) as ExecResult;
      onStep({
        stepIndex: ++stepCounter,
        toolName: "setup",
        input: { command },
        output: { exit_code: data.exit_code, stdout: tail(data.stdout, budgets.maxCommandOutputChars), stderr: tail(data.stderr, budgets.maxCommandOutputChars) }
      });
      if (data.exit_code !== 0) {
        throw new Error(`Setup command failed (exit ${data.exit_code}): ${command}\n${tail(data.stderr, 2000)}`);
      }
    }

    // 3. The tools. Their descriptions come from agent-config.json (below). Sandbox failures in runCommand, getDiff and runTests throw and fail the task;
    //    the file tools hand their errors back to the model.
    const tools: AgentTool[] = [
      {
        definition: {
          name: "runCommand",
          input_schema: {
            type: "object",
            properties: {
              command: { type: "string", description: "The bash command to execute (e.g. pytest, git status)" }
            },
            required: ["command"]
          }
        },
        schema: z.object({ command: z.string() }),
        run: async ({ command }: { command: string }) => {
          const data = await callSandbox("/exec", { command });
          onStep({ stepIndex: ++stepCounter, toolName: "runCommand", input: { command }, output: data });
          return data;
        }
      },
      {
        definition: {
          name: "readFile",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path relative to the repo root" },
              offset: { type: "integer", description: "1-based line number to start from. Defaults to 1." },
              limit: { type: "integer", description: `Maximum number of lines to return. Defaults to ${DEFAULT_READ_LIMIT}.` }
            },
            required: ["path"]
          }
        },
        schema: z.object({
          path: z.string(),
          offset: z.number().int().optional(),
          limit: z.number().int().optional()
        }),
        run: (input) => audited("readFile", input, () => fileTools.readFile(input))
      },
      {
        definition: {
          name: "editFile",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path relative to the repo root" },
              edits: {
                type: "array",
                description: "One or more targeted, non-overlapping replacements.",
                items: {
                  type: "object",
                  properties: {
                    oldText: { type: "string", description: "Exact text to replace. Must be unique in the original file." },
                    newText: { type: "string", description: "Replacement text." }
                  },
                  required: ["oldText", "newText"]
                }
              }
            },
            required: ["path", "edits"]
          }
        },
        schema: z.preprocess(
          prepareEditArguments,
          z.object({
            path: z.string(),
            edits: z.array(z.object({ oldText: z.string(), newText: z.string() }))
          })
        ),
        run: (input) =>
          audited("editFile", { path: input.path, edits: input.edits.length }, () => fileTools.editFile(input))
      },
      {
        definition: {
          name: "writeFile",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path relative to the repo root" },
              content: { type: "string", description: "Complete file contents" }
            },
            required: ["path", "content"]
          }
        },
        schema: z.object({ path: z.string(), content: z.string() }),
        run: ({ path, content }: { path: string; content: string }) =>
          audited("writeFile", { path, contentLength: content.length }, () => fileTools.writeFile({ path, content }))
      },
      {
        definition: {
          name: "getDiff",
          input_schema: { type: "object", properties: {} }
        },
        schema: z.object({}).passthrough(),
        run: async () => {
          const data = (await callSandbox("/exec", { command: DIFF_COMMAND })) as { stdout: string };
          onStep({
            stepIndex: ++stepCounter,
            toolName: "getDiff",
            input: {},
            output: { patchLength: data.stdout?.length ?? 0 }
          });
          return { patch: data.stdout || "" };
        }
      }
    ];
    if (config.test) {
      const testCommand = config.test;
      tools.push({
        definition: {
          name: "runTests",
          input_schema: { type: "object", properties: {} }
        },
        schema: z.object({}).passthrough(),
        run: async () => {
          const data = (await callSandbox("/exec", {
            command: testCommand,
            timeout_seconds: budgets.testTimeoutSeconds
          })) as ExecResult;
          const output = {
            exit_code: data.exit_code,
            stdout: tail(data.stdout, budgets.maxCommandOutputChars),
            stderr: tail(data.stderr, budgets.maxCommandOutputChars)
          };
          onStep({ stepIndex: ++stepCounter, toolName: "runTests", input: { command: testCommand }, output });
          return output;
        }
      });
    }
    // The config picks which tools are offered and words what the model sees about each.
    const descriptionValues = {
      readLimit: DEFAULT_READ_LIMIT,
      maxLineLength: MAX_LINE_LENGTH,
      testCommand: config.test ?? ""
    };
    const offered = tools.filter((t) => agentConfig.tools[t.definition.name as keyof AgentConfig["tools"]]);
    for (const t of offered) {
      t.definition.description = fillTemplate(agentConfig.tools[t.definition.name as keyof AgentConfig["tools"]]!, descriptionValues);
    }
    const toolsByName = new Map(offered.map((t) => [t.definition.name, t]));

    /** Runs one tool call and returns its result block. Bad input goes back to the model as an error. */
    const runToolUse = async (block: Anthropic.Beta.BetaToolUseBlock): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
      const agentTool = toolsByName.get(block.name);
      const parsed = agentTool?.schema.safeParse(block.input);
      if (!agentTool || !parsed?.success) {
        const error = agentTool
          ? `Invalid input for ${block.name}: ${parsed!.error!.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`
          : `Unknown tool: ${block.name}`;
        onStep({ stepIndex: ++stepCounter, toolName: block.name, input: { invalid: true }, output: { error } });
        return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ error }), is_error: true };
      }
      const output = await agentTool.run(parsed.data);
      return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(output) };
    };

    // 4. The agent loop: one model turn, then every tool call it made, until it stops calling tools.
    //    Each assistant turn goes back exactly as the API returned it, thinking blocks included.
    const system = buildSystemPrompt({ repo, testCommand: config.test }, agentConfig);
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
    const useFallbacks = FALLBACK_MODELS.has(modelId);
    let totalTokens = 0;

    for (let turn = 0; turn < budgets.maxTurns; turn++) {
      const response = await client.beta.messages.create({
        model: modelId,
        max_tokens: budgets.maxOutputTokensPerTurn,
        system,
        messages,
        tools: offered.map((t) => t.definition),
        thinking: { type: "adaptive" },
        output_config: { effort },
        // Caches the conversation so far; each turn re-reads it at a tenth of the input price.
        cache_control: { type: "ephemeral" },
        ...(useFallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {})
      });

      const usage = response.usage;
      totalTokens +=
        usage.input_tokens +
        usage.output_tokens +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0);

      if (response.stop_reason === "refusal") {
        const category = response.stop_details?.category ?? "unspecified";
        throw new Error(`The model declined to continue (refusal category: ${category}).`);
      }
      // The token budget is spent: keep what the agent has done and stop, as at the turn budget.
      if (budgets.maxTotalTokens !== null && totalTokens >= budgets.maxTotalTokens) break;

      messages.push({ role: "assistant", content: response.content });
      const toolUses = response.content.filter(
        (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use"
      );

      if (toolUses.length > 0) {
        // All results go back together in one user message.
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const block of toolUses) results.push(await runToolUse(block));
        messages.push({ role: "user", content: results });
        continue;
      }
      if (response.stop_reason === "pause_turn") continue;
      if (response.stop_reason === "max_tokens") {
        messages.push({ role: "user", content: "Your reply hit the output limit. Continue, in smaller steps." });
        continue;
      }
      break;
    }

    // Capture final patch
    const patchRes = (await callSandbox("/exec", { command: DIFF_COMMAND })) as { stdout: string };

    return {
      taskId,
      model: modelId,
      effort,
      agentConfigVersion: resolved.version,
      agentConfigHash: resolved.hash,
      totalTokens,
      stepsCount: stepCounter,
      patch: patchRes.stdout || "",
      verification,
      testCommand: config.test ?? null,
      completedAt: new Date().toISOString()
    };
  } finally {
    // Guarantees sandbox container teardown
    await fetch(`${env.MODAL_SANDBOX_URL}/session/terminate`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.AGENT_SANDBOX_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sessionId, sandbox_id: sessionId })
    }).catch((e) => console.error("Sandbox termination error:", e));
  }
}

/** The system prompt, built from the config's prompt sections. Defaults to the checked-in config. */
export function buildSystemPrompt(
  opts: { repo?: RepoTarget; testCommand?: string },
  agentConfig: Pick<AgentConfig, "systemPrompt"> = rawAgentConfig as AgentConfig
): string {
  const p = agentConfig.systemPrompt;
  const values = {
    repoUrl: opts.repo?.url ?? "",
    ref: opts.repo?.ref ?? "",
    testCommand: opts.testCommand ?? ""
  };
  const sections = [p.intro, ...(opts.repo ? [p.withRepo] : []), p.task, opts.testCommand ? p.withTests : p.withoutTests, p.closing];
  return sections.map((section) => fillTemplate(section, values)).join("\n");
}

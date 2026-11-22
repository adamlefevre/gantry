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
import { prepareEditArguments } from "./tools/editMatching";
import { DEFAULT_READ_LIMIT, FileTools, MAX_LINE_LENGTH } from "./tools/fileTools";

/** Claude model used when the GANTRY_MODEL var is unset. */
export const DEFAULT_MODEL = "claude-opus-5-5";
/**
 * How hard the model thinks on each turn, when the GANTRY_EFFORT var is unset. Claude Opus 5.5
 * defaults to "medium"; coding work does better at "high".
 */
export const DEFAULT_EFFORT: Effort = "high";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
/** Output tokens per model turn. Enough for a whole-file write; small enough to skip streaming. */
const MAX_OUTPUT_TOKENS = 16_000;
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

/** Model turns per task. Setup doesn't count; each turn may call several tools. */
export const MAX_AGENT_STEPS = 16;
/** Seconds each setup command and each test run may take inside the sandbox. */
const SETUP_TIMEOUT_SECONDS = 600;
const TEST_TIMEOUT_SECONDS = 600;
/** Command output kept in step records and returned to the model (the tail, where errors are). */
const MAX_OUTPUT_CHARS = 16_000;

interface ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

function tail(s: string | undefined, max = MAX_OUTPUT_CHARS): string {
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
  const { env, prompt, taskId, repo, onStep, onConfig } = options;

  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    // Unset in production; the tests point it at the mock Anthropic server.
    baseURL: env.ANTHROPIC_BASE_URL || undefined
  });
  const modelId = env.GANTRY_MODEL || DEFAULT_MODEL;
  const effort = (env.GANTRY_EFFORT as Effort | undefined) || DEFAULT_EFFORT;

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
        timeout_seconds: SETUP_TIMEOUT_SECONDS
      })) as ExecResult;
      onStep({
        stepIndex: ++stepCounter,
        toolName: "setup",
        input: { command },
        output: { exit_code: data.exit_code, stdout: tail(data.stdout), stderr: tail(data.stderr) }
      });
      if (data.exit_code !== 0) {
        throw new Error(`Setup command failed (exit ${data.exit_code}): ${command}\n${tail(data.stderr, 2000)}`);
      }
    }

    // 3. The tools. Sandbox failures in runCommand, getDiff and runTests throw and fail the task;
    //    the file tools hand their errors back to the model.
    const tools: AgentTool[] = [
      {
        definition: {
          name: "runCommand",
          description: "Execute a bash shell command in the sandbox",
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
          description: [
            "Read a text file from the repo.",
            `- Returns up to ${DEFAULT_READ_LIMIT} lines from the start of the file. Each line is prefixed with its number as \`<n>: <text>\`; the prefix is not part of the file.`,
            "- offset is the 1-based line to start from. When the result is truncated, read on from nextOffset.",
            `- Lines longer than ${MAX_LINE_LENGTH} characters are cut.`,
            "- Avoid tiny repeated slices. If you need more context, read a larger window."
          ].join("\n"),
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
          description: [
            "Edit one file by exact text replacement. Prefer this to writeFile for changing existing files.",
            "- Every edits[].oldText must match a unique, non-overlapping region of the original file, including whitespace and newlines. Leave out readFile's line-number prefixes.",
            "- Batch changes to one file in a single call. Each edit is matched against the original file, not applied one after another.",
            "- If two changes touch the same block or nearby lines, merge them into one edit. Don't include large unchanged regions just to connect distant changes."
          ].join("\n"),
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
          description: [
            "Write a whole file, creating it or replacing its contents.",
            "- To change an existing file, prefer editFile.",
            "- Overwriting an existing file requires reading it with readFile first, and fails if it changed since that read."
          ].join("\n"),
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
          description: "Generate a unified git diff patch of all current changes",
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
          description: `Run the repository's test suite (\`${testCommand}\`). Use it to check your fix before finishing.`,
          input_schema: { type: "object", properties: {} }
        },
        schema: z.object({}).passthrough(),
        run: async () => {
          const data = (await callSandbox("/exec", {
            command: testCommand,
            timeout_seconds: TEST_TIMEOUT_SECONDS
          })) as ExecResult;
          const output = { exit_code: data.exit_code, stdout: tail(data.stdout), stderr: tail(data.stderr) };
          onStep({ stepIndex: ++stepCounter, toolName: "runTests", input: { command: testCommand }, output });
          return output;
        }
      });
    }
    const toolsByName = new Map(tools.map((t) => [t.definition.name, t]));

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
    const system = buildSystemPrompt({ repo, testCommand: config.test });
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
    const useFallbacks = FALLBACK_MODELS.has(modelId);
    let totalTokens = 0;

    for (let turn = 0; turn < MAX_AGENT_STEPS; turn++) {
      const response = await client.beta.messages.create({
        model: modelId,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        messages,
        tools: tools.map((t) => t.definition),
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

export function buildSystemPrompt(opts: { repo?: RepoTarget; testCommand?: string }): string {
  const lines = [
    "You are Gantry's autonomous software engineer.",
    "You operate inside an isolated Linux sandbox with git, Python and common build tools.",
  ];
  if (opts.repo) {
    lines.push(
      `The repository ${opts.repo.url} (ref ${opts.repo.ref}) is checked out in your working directory, and its setup commands have already run.`,
      "If the repo has an AGENTS.md or CLAUDE.md, read it first and follow its conventions."
    );
  }
  lines.push("Investigate the codebase, reproduce the problem, edit files, and verify your fix.");
  if (opts.testCommand) {
    lines.push(
      `This repo's test command is \`${opts.testCommand}\`. Run it with the runTests tool. Add or update a test that covers the fix, and make sure the full suite passes before you finish.`
    );
  } else {
    lines.push(
      "This repo declares no test command, so your work cannot be verified automatically. Find and run whatever tests exist if you can, and say clearly in your final message what you checked."
    );
  }
  lines.push("When you are done, call getDiff() to produce the final unified patch, then stop.");
  return lines.join("\n");
}

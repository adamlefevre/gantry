import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, tool, type LanguageModelV1, type ToolSet } from "ai";
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

/** LLM round-trips per task. Setup doesn't count; each tool call (including runTests) does. */
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
  modelOverride?: LanguageModelV1;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentTelemetry> {
  const { env, prompt, taskId, repo, onStep, onConfig, modelOverride } = options;

  let model: LanguageModelV1;
  if (modelOverride) {
    model = modelOverride;
  } else {
    const google = createGoogleGenerativeAI({
      apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY
    });
    model = google("gemini-2.5-flash");
  }

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
   * Runs a tool body, records the step, and hands errors back to the model as `{error}`.
   * In AI SDK v4 a thrown tool error would abort the whole loop instead.
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

    // 3. The agent loop.
    const testTools: ToolSet = config.test
      ? {
          runTests: tool({
            description: `Run the repository's test suite (\`${config.test}\`). Use it to check your fix before finishing.`,
            parameters: z.object({}),
            execute: async () => {
              const data = (await callSandbox("/exec", {
                command: config.test,
                timeout_seconds: TEST_TIMEOUT_SECONDS
              })) as ExecResult;
              const output = { exit_code: data.exit_code, stdout: tail(data.stdout), stderr: tail(data.stderr) };
              onStep({ stepIndex: ++stepCounter, toolName: "runTests", input: { command: config.test }, output });
              return output;
            }
          })
        }
      : {};

    const result = await generateText({
      model,
      system: buildSystemPrompt({ repo, testCommand: config.test }),
      prompt,
      maxSteps: MAX_AGENT_STEPS,
      tools: {
        runCommand: tool({
          description: "Execute a bash shell command in the sandbox",
          parameters: z.object({
            command: z.string().describe("The bash command to execute (e.g. pytest, git status)")
          }),
          execute: async ({ command }) => {
            const data = await callSandbox("/exec", { command });
            onStep({
              stepIndex: ++stepCounter,
              toolName: "runCommand",
              input: { command },
              output: data
            });
            return data;
          }
        }),

        readFile: tool({
          description: [
            "Read a text file from the repo.",
            `- Returns up to ${DEFAULT_READ_LIMIT} lines from the start of the file. Each line is prefixed with its number as \`<n>: <text>\`; the prefix is not part of the file.`,
            "- offset is the 1-based line to start from. When the result is truncated, read on from nextOffset.",
            `- Lines longer than ${MAX_LINE_LENGTH} characters are cut.`,
            "- Avoid tiny repeated slices. If you need more context, read a larger window."
          ].join("\n"),
          parameters: z.object({
            path: z.string().describe("File path relative to the repo root"),
            offset: z.number().int().optional().describe("1-based line number to start from. Defaults to 1."),
            limit: z.number().int().optional().describe(`Maximum number of lines to return. Defaults to ${DEFAULT_READ_LIMIT}.`)
          }),
          execute: (input) => audited("readFile", input, () => fileTools.readFile(input))
        }),

        editFile: tool({
          description: [
            "Edit one file by exact text replacement. Prefer this to writeFile for changing existing files.",
            "- Every edits[].oldText must match a unique, non-overlapping region of the original file, including whitespace and newlines. Leave out readFile's line-number prefixes.",
            "- Batch changes to one file in a single call. Each edit is matched against the original file, not applied one after another.",
            "- If two changes touch the same block or nearby lines, merge them into one edit. Don't include large unchanged regions just to connect distant changes."
          ].join("\n"),
          parameters: z.preprocess(
            prepareEditArguments,
            z.object({
              path: z.string().describe("File path relative to the repo root"),
              edits: z
                .array(
                  z.object({
                    oldText: z.string().describe("Exact text to replace. Must be unique in the original file."),
                    newText: z.string().describe("Replacement text.")
                  })
                )
                .describe("One or more targeted, non-overlapping replacements.")
            })
          ),
          execute: (input) =>
            audited("editFile", { path: input.path, edits: input.edits.length }, () => fileTools.editFile(input))
        }),

        writeFile: tool({
          description: [
            "Write a whole file, creating it or replacing its contents.",
            "- To change an existing file, prefer editFile.",
            "- Overwriting an existing file requires reading it with readFile first, and fails if it changed since that read."
          ].join("\n"),
          parameters: z.object({
            path: z.string().describe("File path relative to the repo root"),
            content: z.string().describe("Complete file contents")
          }),
          execute: ({ path, content }) =>
            audited("writeFile", { path, contentLength: content.length }, () => fileTools.writeFile({ path, content }))
        }),

        getDiff: tool({
          description: "Generate a unified git diff patch of all current changes",
          parameters: z.object({}),
          execute: async () => {
            const data = (await callSandbox("/exec", { command: "git diff" })) as { stdout: string };
            onStep({
              stepIndex: ++stepCounter,
              toolName: "getDiff",
              input: {},
              output: { patchLength: data.stdout?.length ?? 0 }
            });
            return { patch: data.stdout || "" };
          }
        }),

        ...testTools
      }
    });

    // Capture final patch
    const patchRes = (await callSandbox("/exec", { command: "git diff" })) as { stdout: string };

    return {
      taskId,
      model: "gemini-2.5-flash",
      totalTokens: result.usage?.totalTokens ?? 0,
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

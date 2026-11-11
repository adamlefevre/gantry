import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, tool, type LanguageModelV1 } from "ai";
import { z } from "zod";
import type { Env } from "./TaskCoordinator";

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
  modelOverride?: LanguageModelV1;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentTelemetry> {
  const { env, prompt, taskId, repo, onStep, modelOverride } = options;

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

  let stepCounter = 0;

  try {
    const result = await generateText({
      model,
      system: `You are Gantry's autonomous software engineer.
You operate inside a Linux sandbox with git, pytest, and python.
${repo ? `The repository ${repo.url} (ref ${repo.ref}) is checked out in your working directory.
` : ""}Investigate the codebase, reproduce issues using pytest, edit files, and verify fixes.
Once tests pass, call getDiff() to generate the final unified patch and exit.`,
      prompt,
      maxSteps: 8,
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

        writeFile: tool({
          description: "Write content to a file inside the sandbox",
          parameters: z.object({
            path: z.string().describe("Relative file path"),
            content: z.string().describe("File body content")
          }),
          execute: async ({ path, content }) => {
            const data = await callSandbox("/file/write", { path, content });
            onStep({
              stepIndex: ++stepCounter,
              toolName: "writeFile",
              input: { path, contentLength: content.length },
              output: data
            });
            return data;
          }
        }),

        readFile: tool({
          description: "Read file contents from the sandbox",
          parameters: z.object({
            path: z.string().describe("Relative file path")
          }),
          execute: async ({ path }) => {
            const data = await callSandbox("/file/read", { path });
            onStep({
              stepIndex: ++stepCounter,
              toolName: "readFile",
              input: { path },
              output: data
            });
            return data;
          }
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
        })
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

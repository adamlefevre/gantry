import { z } from "zod";
import rawAgentConfig from "../agent-config.json";

/**
 * The agent's prompt, tools, model and budgets, kept in `apps/control-plane/agent-config.json` so a
 * change to how the agent works is a diff to one file, and every run records which config it used
 * (ADR 0006). This is Gantry's own config, written by its maintainers, unlike `.gantry.yml`, which
 * comes from the target repo.
 */

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** The tools agent.ts knows how to run. A config may offer fewer, never others. */
export const TOOL_NAMES = ["runCommand", "readFile", "editFile", "writeFile", "getDiff", "runTests"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Text is kept as arrays of lines, so a one-line change to a prompt is a one-line diff. */
const lines = z.array(z.string()).min(1);
const positiveInt = z.number().int().positive();

const toolsSchema = z
  .object(Object.fromEntries(TOOL_NAMES.map((name) => [name, lines.optional()])) as Record<ToolName, z.ZodOptional<typeof lines>>)
  .strict()
  .refine((tools) => Object.values(tools).some(Boolean), "offer at least one tool");

export const agentConfigSchema = z
  .object({
    $comment: z.string().optional(),
    /** Bump on every change you mean to compare. Stamped on every run's telemetry. */
    version: z.string().trim().min(1).max(64),
    model: z.string().trim().min(1),
    effort: z.enum(EFFORTS),
    budgets: z
      .object({
        /** Model turns per task. Setup doesn't count; each turn may call several tools. */
        maxTurns: positiveInt,
        /** Stop after the turn that takes the run to this many tokens (cache reads included). Null: no cap. */
        maxTotalTokens: positiveInt.nullable(),
        /** Output tokens per model turn. Enough for a whole-file write; small enough to skip streaming. */
        maxOutputTokensPerTurn: positiveInt,
        /** Seconds each setup command and each test run may take inside the sandbox. */
        setupTimeoutSeconds: positiveInt,
        testTimeoutSeconds: positiveInt,
        /** Command output kept in step records and returned to the model (the tail, where errors are). */
        maxCommandOutputChars: positiveInt
      })
      .strict(),
    /** Joined with newlines in this order. `withRepo` only when a repo is cloned; one of the test sections. */
    systemPrompt: z
      .object({
        intro: lines,
        withRepo: lines,
        task: lines,
        withTests: lines,
        withoutTests: lines,
        closing: lines
      })
      .strict(),
    /** The tools offered, by name, with the description the model sees. `runTests` needs a repo test command too. */
    tools: toolsSchema
  })
  .strict();

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export interface ResolvedAgentConfig {
  config: AgentConfig;
  /** `version` from the file. */
  version: string;
  /**
   * The first 16 hex digits of the SHA-256 of the config this run used, after the GANTRY_MODEL and
   * GANTRY_EFFORT overrides. Two runs with the same hash ran the same prompt, tools, model and budgets.
   */
  hash: string;
}

export class AgentConfigError extends Error {}

export function parseAgentConfig(raw: unknown): AgentConfig {
  const result = agentConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new AgentConfigError(`agent-config.json is invalid: ${issues.join("; ")}`);
  }
  return result.data;
}

/** The checked-in config, with the GANTRY_MODEL and GANTRY_EFFORT vars applied, and its hash. */
export async function resolveAgentConfig(
  overrides: { model?: string; effort?: string } = {},
  raw: unknown = rawAgentConfig
): Promise<ResolvedAgentConfig> {
  const base = parseAgentConfig(raw);
  if (overrides.effort && !(EFFORTS as readonly string[]).includes(overrides.effort)) {
    throw new AgentConfigError(`GANTRY_EFFORT must be one of ${EFFORTS.join(", ")}, not "${overrides.effort}"`);
  }
  const { $comment: _comment, ...config } = {
    ...base,
    model: overrides.model || base.model,
    effort: (overrides.effort as Effort | undefined) || base.effort
  };
  return { config, version: config.version, hash: await hashConfig(config) };
}

/** Fills `{name}` placeholders. Only the names given are replaced, so other braces stay as written. */
export function fillTemplate(text: readonly string[], values: Record<string, string | number>): string {
  return text
    .join("\n")
    .replace(/\{([A-Za-z]+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}

async function hashConfig(config: AgentConfig): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(config));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** JSON with object keys sorted, so the hash doesn't depend on key order in the file. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

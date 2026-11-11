import { parse } from "yaml";
import { z } from "zod";

/**
 * `.gantry.yml` at the target repo root (ADR 0001, decision 2; parsing location: ADR 0002).
 *
 *   setup: npm ci            # or a list of commands, run in order before the agent starts
 *   test: npm test           # how the factory verifies the agent's work
 *   image: node:22           # parsed, not acted on yet
 *
 * The file comes from the target repo, so it is untrusted. It is parsed here in the Worker, and
 * `setup`/`test` are only ever run inside the sandbox, through /exec.
 */
export const GANTRY_CONFIG_PATH = ".gantry.yml";
export const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_COMMAND_CHARS = 4096;

const command = z.string().trim().min(1).max(MAX_COMMAND_CHARS);

const schema = z
  .object({
    setup: z.union([command, z.array(command).max(20)]).optional(),
    test: command.optional(),
    image: z.string().trim().min(1).max(256).optional(),
  })
  // Unknown keys are ignored so repos can add fields for later versions.
  .strip();

export interface GantryConfig {
  /** Commands to run, in order, after checkout and before the agent loop. */
  setup: string[];
  /** The command that verifies the agent's work. Absent → the run is unverified. */
  test?: string;
  image?: string;
}

/**
 * `unverified`: the repo has no `test:` command, so the run can only ever produce a draft PR.
 * `pending`: a test command exists; factory red-green verification (rollout step 4) sets the result.
 */
export type Verification = "unverified" | "pending";

export class GantryConfigError extends Error {}

/** Parses `.gantry.yml`. Pass `null` when the file is absent. */
export function parseGantryConfig(text: string | null): GantryConfig {
  if (text === null) return { setup: [] };
  if (text.length > MAX_CONFIG_BYTES) {
    throw new GantryConfigError(`${GANTRY_CONFIG_PATH} is larger than ${MAX_CONFIG_BYTES} bytes`);
  }

  let raw: unknown;
  try {
    // No aliases: a config file never needs them, and they enable expansion bombs.
    raw = parse(text, { maxAliasCount: 0 });
  } catch (e: any) {
    throw new GantryConfigError(`${GANTRY_CONFIG_PATH} is not valid YAML: ${e.message}`);
  }
  if (raw === null || raw === undefined) return { setup: [] }; // empty file

  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new GantryConfigError(`${GANTRY_CONFIG_PATH} is invalid: ${issues.join("; ")}`);
  }

  const { setup, test, image } = result.data;
  return {
    setup: setup === undefined ? [] : Array.isArray(setup) ? setup : [setup],
    test,
    image,
  };
}

export function verificationFor(config: GantryConfig): Verification {
  return config.test ? "pending" : "unverified";
}

// The agent's file tools: paged reads, guarded whole-file writes, and exact-text edits.
//
// Behaviour follows eve's read_file, write_file and edit_file
// (https://github.com/vercel/eve, packages/eve/src/execution/sandbox/{read,write}-file.ts and
// tools/provided/edit-file.ts, 1.0.0-rc.9, Apache-2.0). See NOTICE. The tools run in the
// Worker and reach the sandbox only through `SandboxFiles`.

import { applyEdits, type Edit } from "./editMatching";

/** What the file tools need from the sandbox: `/file/read` and `/file/write`. */
export interface SandboxFiles {
  /** The file's text, or null when it doesn't exist. `truncated`: larger than the service's read cap. */
  read(path: string): Promise<{ content: string; truncated: boolean } | null>;
  write(path: string, content: string): Promise<void>;
}

export const DEFAULT_READ_LIMIT = 2000;
export const MAX_LINE_LENGTH = 2000;
/** Cap on one readFile result, so a single read can't flood the context. */
export const MAX_READ_OUTPUT_BYTES = 50 * 1024;
const LINE_TRUNCATION_SUFFIX = "… [line truncated]";

export interface ReadFileResult {
  path: string;
  /** Lines prefixed with their 1-based number, as `<n>: <text>`. */
  content: string;
  totalLines: number;
  truncated: boolean;
  /** Set when truncated: the offset to read the rest from. */
  nextOffset?: number;
}

export interface WriteFileResult {
  path: string;
  existed: boolean;
}

export interface EditFileResult {
  path: string;
  replacements: number;
}

const encoder = new TextEncoder();

/** Normalizes a model-supplied path into the key stamps and queues use. Paths are relative to /workspace. */
export function normalizePath(path: string): string {
  let p = path.trim().replace(/\\/g, "/");
  if (p.startsWith("/workspace/")) p = p.slice("/workspace/".length);
  if (p.startsWith("/")) throw new Error(`Path ${path} is outside the workspace. Use a path relative to the repo root.`);
  const parts: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error(`Path ${path} is outside the workspace.`);
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if (parts.length === 0) throw new Error(`Path ${path} is not a file.`);
  return parts.join("/");
}

async function hash(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(content));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function capLine(line: string): string {
  return line.length <= MAX_LINE_LENGTH ? line : line.slice(0, MAX_LINE_LENGTH) + LINE_TRUNCATION_SUFFIX;
}

/** A file whose text came back with U+FFFD may not be UTF-8; rewriting it would corrupt its bytes. */
function looksUndecodable(content: string): boolean {
  return content.includes("�") || content.includes("\0");
}

/**
 * File tools for one task. Holds the read stamps (what the model last read of each file)
 * and a per-file queue, because the AI SDK runs a step's tool calls in parallel.
 */
export class FileTools {
  private stamps = new Map<string, string>();
  private queues = new Map<string, Promise<void>>();

  constructor(private readonly files: SandboxFiles) {}

  async readFile(input: { path: string; offset?: number; limit?: number }): Promise<ReadFileResult> {
    const path = normalizePath(input.path);
    const offset = input.offset ?? 1;
    const limit = input.limit ?? DEFAULT_READ_LIMIT;
    if (!Number.isInteger(offset) || offset < 1) throw new Error(`offset must be >= 1. Received: ${offset}.`);
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`limit must be >= 1. Received: ${limit}.`);

    const file = await this.files.read(path);
    if (file === null) {
      throw new Error(`File not found: ${path}. Verify the path exists in the repo.`);
    }
    if (file.content.includes("\0")) {
      throw new Error(`File ${path} appears to be a binary file. readFile only supports text files.`);
    }

    const lines = file.content.split("\n");
    const totalLines = lines.at(-1) === "" ? lines.length - 1 : lines.length;
    if (totalLines === 0) {
      if (offset > 1) throw new Error(`offset ${offset} is past the end of the file (0 lines).`);
    } else if (offset > totalLines) {
      throw new Error(`offset ${offset} is past the end of the file (${totalLines} lines).`);
    }

    // A read the service cut short can't vouch for the whole file, so it doesn't allow a write.
    if (!file.truncated) this.stamps.set(path, await hash(file.content));

    const end = Math.min(offset - 1 + limit, totalLines);
    const out: string[] = [];
    let bytes = 0;
    for (let i = offset - 1; i < end; i++) {
      const numbered = `${i + 1}: ${capLine(lines[i] ?? "")}`;
      const size = encoder.encode(numbered).length + 1;
      if (bytes + size > MAX_READ_OUTPUT_BYTES && out.length > 0) break;
      out.push(numbered);
      bytes += size;
    }

    const last = offset - 1 + out.length;
    const truncated = last < totalLines;
    const result: ReadFileResult = { path, content: out.join("\n"), totalLines, truncated };
    if (truncated) result.nextOffset = last + 1;
    if (file.truncated) {
      result.content += "\n[The file is larger than the sandbox's read limit; later lines are not available. Use runCommand to inspect the rest.]";
    }
    return result;
  }

  async writeFile(input: { path: string; content: string }): Promise<WriteFileResult> {
    const path = normalizePath(input.path);
    return this.serialized(path, async () => {
      const current = await this.files.read(path);
      if (current !== null) {
        const stamp = this.stamps.get(path);
        if (stamp === undefined) {
          throw new Error(`You must read file ${path} before overwriting it. Use the readFile tool first.`);
        }
        if (current.truncated || stamp !== (await hash(current.content))) {
          throw new Error(
            `File ${path} has been modified since it was last read. Please read the file again before modifying it.`
          );
        }
      }
      await this.files.write(path, input.content);
      this.stamps.set(path, await hash(input.content));
      return { path, existed: current !== null };
    });
  }

  async editFile(input: { path: string; edits: Edit[] }): Promise<EditFileResult> {
    const path = normalizePath(input.path);
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
      throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
    }
    return this.serialized(path, async () => {
      const file = await this.files.read(path);
      if (file === null) throw new Error(`Could not edit file: ${path}. Error code: ENOENT.`);
      if (file.truncated) {
        throw new Error(`Could not edit file: ${path}. It is larger than the sandbox's read limit.`);
      }
      if (looksUndecodable(file.content)) {
        throw new Error(`Could not edit file: ${path}. It is not valid UTF-8 text.`);
      }

      const updated = applyEdits(file.content, input.edits, path);
      await this.files.write(path, updated);

      // Keep the read stamp current only when the model had read the version it just edited,
      // so a change made since that read still fails the next writeFile.
      const before = await hash(file.content);
      if (this.stamps.get(path) === before) this.stamps.set(path, await hash(updated));
      return { path, replacements: input.edits.length };
    });
  }

  /** Serializes work on one path; work on different paths still runs in parallel. */
  private async serialized<T>(path: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(path) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const queued = previous.then(() => current);
    this.queues.set(path, queued);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (this.queues.get(path) === queued) this.queues.delete(path);
    }
  }
}

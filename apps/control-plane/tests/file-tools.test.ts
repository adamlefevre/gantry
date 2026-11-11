import { describe, it, expect } from "vitest";
import { FileTools, normalizePath, type SandboxFiles } from "../src/tools/fileTools";
import { prepareEditArguments, type Edit } from "../src/tools/editMatching";

/** In-memory sandbox files. `truncated` marks paths the service would cut at its read cap. */
function fakeFiles(initial: Record<string, string>, truncated: string[] = []) {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const sandbox: SandboxFiles = {
    async read(path) {
      const content = files.get(path);
      return content === undefined ? null : { content, truncated: truncated.includes(path) };
    },
    async write(path, content) {
      await Promise.resolve();
      writes.push(path);
      files.set(path, content);
    },
  };
  return { files, writes, tools: new FileTools(sandbox) };
}

// Cases ported from eve's edit-file.test.ts (which keeps pi's messages).
describe("editFile", () => {
  it("applies every edit against the original file and keeps its BOM and CRLF endings", async () => {
    const { files, tools } = fakeFiles({
      "src/app.ts": "﻿const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n",
    });
    const out = await tools.editFile({
      path: "src/app.ts",
      edits: [
        { oldText: "const c = 3;", newText: "const c = 30;" },
        { oldText: "const a = 1;\nconst b = 2;", newText: "const a = 10;\nconst b = 20;" },
      ],
    });
    expect(files.get("src/app.ts")).toBe("﻿const a = 10;\r\nconst b = 20;\r\nconst c = 30;\r\n");
    expect(out).toEqual({ path: "src/app.ts", replacements: 2 });
  });

  it("matches text that differs only in smart quotes, dashes, or trailing spaces, keeping other lines' bytes", async () => {
    const { files, tools } = fakeFiles({ "notes.md": "Alice’s note  \nkeep “this” — as is\nBob – done\n" });
    await tools.editFile({ path: "notes.md", edits: [{ oldText: "Bob - done", newText: "Bob - shipped" }] });
    await tools.editFile({ path: "notes.md", edits: [{ oldText: "Alice's note", newText: "Alice's plan" }] });
    expect(files.get("notes.md")).toBe("Alice's plan\nkeep “this” — as is\nBob - shipped\n");
  });

  it.each<{ name: string; edits: Edit[]; message: string }>([
    {
      name: "a missing oldText",
      edits: [{ oldText: "absent", newText: "x" }],
      message: "Could not find the exact text in a.txt. The old text must match exactly including all whitespace and newlines.",
    },
    {
      name: "a missing oldText among several edits",
      edits: [
        { oldText: "one", newText: "1" },
        { oldText: "absent", newText: "x" },
      ],
      message: "Could not find edits[1] in a.txt. The oldText must match exactly including all whitespace and newlines.",
    },
    {
      name: "an ambiguous oldText",
      edits: [{ oldText: "two", newText: "2" }],
      message: "Found 2 occurrences of the text in a.txt. The text must be unique. Please provide more context to make it unique.",
    },
    {
      name: "overlapping edits",
      edits: [
        { oldText: "one two", newText: "x" },
        { oldText: "two three", newText: "y" },
      ],
      message: "edits[0] and edits[1] overlap in a.txt. Merge them into one edit or target disjoint regions.",
    },
    { name: "an empty oldText", edits: [{ oldText: "", newText: "x" }], message: "oldText must not be empty in a.txt." },
    {
      name: "an edit that changes nothing",
      edits: [{ oldText: "one", newText: "one" }],
      message: "No changes made to a.txt. The replacement produced identical content.",
    },
    { name: "no edits", edits: [], message: "Edit tool input is invalid. edits must contain at least one replacement." },
  ])("rejects $name and leaves the file unchanged", async ({ edits, message }) => {
    const original = "one two three\ntwo\n";
    const { files, writes, tools } = fakeFiles({ "a.txt": original });
    await expect(tools.editFile({ path: "a.txt", edits })).rejects.toThrow(message);
    expect(files.get("a.txt")).toBe(original);
    expect(writes).toEqual([]);
  });

  it("reports a missing file", async () => {
    await expect(
      fakeFiles({}).tools.editFile({ path: "gone.txt", edits: [{ oldText: "a", newText: "b" }] })
    ).rejects.toThrow("Could not edit file: gone.txt. Error code: ENOENT.");
  });

  it("refuses a file that may not be UTF-8 instead of rewriting it", async () => {
    const { writes, tools } = fakeFiles({ "menu.txt": "caf�\nold\n" });
    await expect(tools.editFile({ path: "menu.txt", edits: [{ oldText: "old", newText: "new" }] })).rejects.toThrow(
      "Could not edit file: menu.txt. It is not valid UTF-8 text."
    );
    expect(writes).toEqual([]);
  });

  it("refuses a file the sandbox only read part of", async () => {
    const { writes, tools } = fakeFiles({ "big.log": "old\n" }, ["big.log"]);
    await expect(tools.editFile({ path: "big.log", edits: [{ oldText: "old", newText: "new" }] })).rejects.toThrow(
      "larger than the sandbox's read limit"
    );
    expect(writes).toEqual([]);
  });

  it("serializes concurrent edits to the same file", async () => {
    const { files, tools } = fakeFiles({ "a.txt": "alpha\nbeta\n" });
    await Promise.all([
      tools.editFile({ path: "a.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] }),
      tools.editFile({ path: "./a.txt", edits: [{ oldText: "beta", newText: "BETA" }] }),
    ]);
    expect(files.get("a.txt")).toBe("ALPHA\nBETA\n");
  });

  it.each<{ name: string; input: Record<string, unknown> }>([
    { name: "edits as a JSON string", input: { edits: '[{"oldText":"a","newText":"b"}]' } },
    { name: "a single edit object", input: { edits: { oldText: "a", newText: "b" } } },
    { name: "a top-level oldText and newText", input: { oldText: "a", newText: "b" } },
  ])("repairs $name into one edit", ({ input }) => {
    expect(prepareEditArguments({ path: "a.txt", ...input })).toEqual({
      path: "a.txt",
      edits: [{ oldText: "a", newText: "b" }],
    });
  });
});

describe("writeFile read-before-write guard", () => {
  it("creates a new file without a prior read", async () => {
    const { files, tools } = fakeFiles({});
    expect(await tools.writeFile({ path: "src/new.py", content: "x = 1\n" })).toEqual({ path: "src/new.py", existed: false });
    expect(files.get("src/new.py")).toBe("x = 1\n");
  });

  it("refuses to overwrite a file the model never read", async () => {
    const { files, tools } = fakeFiles({ "a.py": "old\n" });
    await expect(tools.writeFile({ path: "a.py", content: "new\n" })).rejects.toThrow(
      "You must read file a.py before overwriting it."
    );
    expect(files.get("a.py")).toBe("old\n");
  });

  it("overwrites a file after reading it", async () => {
    const { files, tools } = fakeFiles({ "a.py": "old\n" });
    await tools.readFile({ path: "a.py" });
    expect(await tools.writeFile({ path: "a.py", content: "new\n" })).toEqual({ path: "a.py", existed: true });
    expect(files.get("a.py")).toBe("new\n");
  });

  it("refuses when the file changed since the read", async () => {
    const { files, tools } = fakeFiles({ "a.py": "old\n" });
    await tools.readFile({ path: "a.py" });
    files.set("a.py", "old\nformatted\n"); // e.g. a formatter ran through runCommand
    await expect(tools.writeFile({ path: "a.py", content: "new\n" })).rejects.toThrow(
      "File a.py has been modified since it was last read."
    );
  });

  it("stays writable after the model edits the version it read", async () => {
    const { files, tools } = fakeFiles({ "notes.md": "draft\n" });
    await tools.readFile({ path: "notes.md" });
    await tools.editFile({ path: "notes.md", edits: [{ oldText: "draft", newText: "plan" }] });
    await tools.writeFile({ path: "notes.md", content: "final\n" });
    expect(files.get("notes.md")).toBe("final\n");
  });

  it("still refuses after an edit when the file had changed since the read", async () => {
    const { files, tools } = fakeFiles({ "notes.md": "draft\n" });
    await tools.readFile({ path: "notes.md" });
    files.set("notes.md", "draft\nformatted\n");
    await tools.editFile({ path: "notes.md", edits: [{ oldText: "draft", newText: "plan" }] });
    await expect(tools.writeFile({ path: "notes.md", content: "final\n" })).rejects.toThrow("modified since it was last read");
    expect(files.get("notes.md")).toBe("plan\nformatted\n");
  });

  it("doesn't count a partial read as a read", async () => {
    const { tools } = fakeFiles({ "big.log": "a\n" }, ["big.log"]);
    await tools.readFile({ path: "big.log" });
    await expect(tools.writeFile({ path: "big.log", content: "b\n" })).rejects.toThrow("You must read file big.log");
  });
});

describe("readFile paging", () => {
  const fiveLines = "l1\nl2\nl3\nl4\nl5\n";

  it("numbers lines and returns the whole small file", async () => {
    const { tools } = fakeFiles({ "a.txt": fiveLines });
    expect(await tools.readFile({ path: "a.txt" })).toEqual({
      path: "a.txt",
      content: "1: l1\n2: l2\n3: l3\n4: l4\n5: l5",
      totalLines: 5,
      truncated: false,
    });
  });

  it("pages with offset and limit and says where to continue", async () => {
    const { tools } = fakeFiles({ "a.txt": fiveLines });
    expect(await tools.readFile({ path: "a.txt", offset: 2, limit: 2 })).toEqual({
      path: "a.txt",
      content: "2: l2\n3: l3",
      totalLines: 5,
      truncated: true,
      nextOffset: 4,
    });
  });

  it("caps very long lines", async () => {
    const { tools } = fakeFiles({ "min.js": "x".repeat(5000) });
    const out = await tools.readFile({ path: "min.js" });
    expect(out.content.length).toBeLessThan(2100);
    expect(out.content).toContain("[line truncated]");
  });

  it("caps the result size even within the line limit", async () => {
    const { tools } = fakeFiles({ "wide.txt": Array.from({ length: 1000 }, () => "y".repeat(200)).join("\n") });
    const out = await tools.readFile({ path: "wide.txt" });
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBeLessThanOrEqual(50 * 1024);
    expect(out.nextOffset).toBeGreaterThan(1);
  });

  it("rejects an offset past the end, and a missing file", async () => {
    const { tools } = fakeFiles({ "a.txt": fiveLines });
    await expect(tools.readFile({ path: "a.txt", offset: 9 })).rejects.toThrow("past the end of the file (5 lines)");
    await expect(tools.readFile({ path: "nope.txt" })).rejects.toThrow("File not found: nope.txt");
  });

  it("notes when the service cut the file short", async () => {
    const { tools } = fakeFiles({ "big.log": "a\nb\n" }, ["big.log"]);
    expect((await tools.readFile({ path: "big.log" })).content).toContain("larger than the sandbox's read limit");
  });
});

describe("normalizePath", () => {
  it("makes paths relative to the workspace", () => {
    expect(normalizePath("./src//a.py")).toBe("src/a.py");
    expect(normalizePath("/workspace/src/a.py")).toBe("src/a.py");
    expect(normalizePath("src/../lib/b.py")).toBe("lib/b.py");
  });

  it("rejects paths outside the workspace", () => {
    expect(() => normalizePath("/etc/passwd")).toThrow("outside the workspace");
    expect(() => normalizePath("../secrets")).toThrow("outside the workspace");
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import esbuild from "esbuild";
import { MockModalServer } from "./mock-modal-server";
import { MockGitHubServer } from "./mock-github-server";
import { MockGeminiServer, toolResultsIn } from "./mock-gemini-server";

let mf: Miniflare;
let modalServer: MockModalServer;
let githubServer: MockGitHubServer;
let geminiServer: MockGeminiServer;
let workerScript: string;

beforeAll(async () => {
  // 1. Start the mock Modal server
  modalServer = new MockModalServer();
  await modalServer.start();
  githubServer = new MockGitHubServer();
  await githubServer.start();
  geminiServer = new MockGeminiServer();
  await geminiServer.start();

  // 2. Bundle the worker entry with esbuild so Miniflare can load it
  const build = await esbuild.build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    format: "esm",
    write: false,
    external: ["cloudflare:workers"],
    target: "es2022",
    // Inline the ai-sdk so the agent module resolves inside workerd
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
  });
  workerScript = build.outputFiles[0].text;

  // 3. Create the Miniflare instance with DO + R2 + bindings
  mf = new Miniflare({
    modules: true,
    compatibilityDate: "2026-03-01",
    compatibilityFlags: ["nodejs_compat"],
    script: workerScript,
    durableObjects: {
      TASK_COORDINATOR: { className: "TaskCoordinator", useSQLite: true },
    },
    r2Buckets: ["GANTRY_BUCKET"],
    bindings: {
      MODAL_SANDBOX_URL: modalServer.url,
      AGENT_SANDBOX_TOKEN: "mock-token",
      GOOGLE_GENERATIVE_AI_API_KEY: "mock-key",
      GOOGLE_GENERATIVE_AI_BASE_URL: geminiServer.url,
      GITHUB_API_URL: githubServer.url,
    },
  });

  await mf.ready;
});

afterAll(async () => {
  await mf?.dispose();
  await modalServer?.stop();
  await githubServer?.stop();
  await geminiServer?.stop();
});

// ──────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────

/** Get a DO stub for a given task name */
async function getStub(taskName: string) {
  const ns = await mf.getDurableObjectNamespace("TASK_COORDINATOR");
  const id = ns.idFromName(taskName);
  return ns.get(id);
}

function startTask(taskId: string, body: Record<string, unknown>) {
  return mf.dispatchFetch(`http://localhost/api/tasks/${taskId}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Polls /status until the task is RESOLVED or FAILED. */
async function waitForTask(taskId: string): Promise<any> {
  const deadline = Date.now() + 15_000;
  let task: any = null;
  while (Date.now() < deadline) {
    const res = await mf.dispatchFetch(`http://localhost/api/tasks/${taskId}/status`);
    task = ((await res.json()) as { task: any }).task;
    if (task && (task.status === "RESOLVED" || task.status === "FAILED")) return task;
    await new Promise((r) => setTimeout(r, 100));
  }
  return task;
}

function sessionFor(taskId: string) {
  return [...modalServer.sessions.values()].find((s) => s.taskId === taskId);
}

// ──────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────

describe("TaskCoordinator Durable Object", () => {
  it("returns null task on /status for a fresh DO", async () => {
    const stub = await getStub("fresh-task");
    const res = await stub.fetch("http://do/status");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { task: null };
    expect(data.task).toBeNull();
  });

  it("returns 404 for unknown routes", async () => {
    const stub = await getStub("not-found");
    const res = await stub.fetch("http://do/unknown");
    expect(res.status).toBe(404);
  });

  it("returns empty steps list for a fresh DO", async () => {
    const stub = await getStub("no-steps");
    const res = await stub.fetch("http://do/steps");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { steps: unknown[] };
    expect(data.steps).toEqual([]);
  });
});

describe("Task start + agent loop (mocked Modal)", () => {
  const TASK_ID = "e2e-task-001";

  it("starts a task and eventually records RESOLVED status with steps", async () => {
    const stub = await getStub(TASK_ID);

    // POST /start triggers the agent loop (runs in background via waitUntil)
    const startRes = await stub.fetch("http://do/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: TASK_ID,
        prompt: "Fix the compaction pipeline in pipelines/compact.py",
      }),
    });
    expect(startRes.status).toBe(200);
    const startData = (await startRes.json()) as { success: boolean; taskId: string };
    expect(startData.success).toBe(true);
    expect(startData.taskId).toBe(TASK_ID);

    // The agent loop runs via ctx.waitUntil. In Miniflare's test mode the
    // waitUntil promise is resolved before the next fetch on the same stub,
    // but we also need a short delay for the async agent to finish because
    // the agent calls out to the mock server over HTTP.
    // Poll /status until we see a terminal state, with a timeout.
    let task: any = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const statusRes = await stub.fetch("http://do/status");
      const statusData = (await statusRes.json()) as { task: any };
      task = statusData.task;
      if (task && (task.status === "RESOLVED" || task.status === "FAILED")) {
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    // -- Task assertions --
    expect(task).toBeTruthy();
    expect(task.id).toBe(TASK_ID);
    // No script matches this prompt, so the mock model answers "Done." on its first turn.
    expect(task.status).toBe("RESOLVED");
    const [llmCall] = geminiServer.requestsFor("Fix the compaction pipeline");
    expect(llmCall).toMatchObject({ model: "gemini-2.5-flash", apiKey: "mock-key" });
    expect(task.prompt).toBe("Fix the compaction pipeline in pipelines/compact.py");
    expect(task.created_at).toBeTruthy();
    expect(task.updated_at).toBeTruthy();
  });

  it("recorded the task in SQLite via /status", async () => {
    const stub = await getStub(TASK_ID);
    const res = await stub.fetch("http://do/status");
    const data = (await res.json()) as { task: any };
    expect(data.task).toBeTruthy();
    expect(data.task.id).toBe(TASK_ID);
  });

  it("mock Modal server received /session/create", async () => {
    const creates = modalServer.requests.filter(
      (r) => r.endpoint === "/session/create"
    );
    expect(creates.length).toBeGreaterThanOrEqual(1);
  });

  it("mock Modal server received /session/terminate", async () => {
    // The finally block in the agent always calls terminate
    const terminates = modalServer.requests.filter(
      (r) => r.endpoint === "/session/terminate"
    );
    expect(terminates.length).toBeGreaterThanOrEqual(1);
  });

  it("all sandbox sessions were terminated", async () => {
    // Every session the mock created should have been terminated
    expect(modalServer.allSessionsTerminated()).toBe(true);
  });
});

describe("Task targeting a repo", () => {
  it("passes repoUrl and ref through to /session/create and stores them", async () => {
    const taskId = "repo-task-001";
    const repoUrl = "https://github.com/example/widgets";
    const res = await mf.dispatchFetch(`http://localhost/api/tasks/${taskId}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Fix issue #1", repoUrl, ref: "main" }),
    });
    expect(res.status).toBe(200);

    const deadline = Date.now() + 15_000;
    let create: any;
    while (Date.now() < deadline && !create) {
      create = modalServer.requests.find(
        (r) => r.endpoint === "/session/create" && r.body.taskId === taskId
      );
      if (!create) await new Promise((r) => setTimeout(r, 100));
    }
    expect(create?.body).toMatchObject({ repo_url: repoUrl, ref: "main" });

    const status = await mf.dispatchFetch(`http://localhost/api/tasks/${taskId}/status`);
    const { task } = (await status.json()) as { task: any };
    expect(task).toMatchObject({ repo_url: repoUrl, ref: "main" });
  });

  it("defaults ref to HEAD when only repoUrl is given", async () => {
    const taskId = "repo-task-002";
    await mf.dispatchFetch(`http://localhost/api/tasks/${taskId}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "x", repoUrl: "https://github.com/example/widgets" }),
    });
    const status = await mf.dispatchFetch(`http://localhost/api/tasks/${taskId}/status`);
    const { task } = (await status.json()) as { task: any };
    expect(task.ref).toBe("HEAD");
  });
});

describe("Entry Worker routing", () => {
  it("routes /api/tasks/:id/start to the DO", async () => {
    const taskId = "route-test-start";
    const res = await mf.dispatchFetch(
      `http://localhost/api/tasks/${taskId}/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Hello from routing test" }),
      }
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean; taskId: string };
    expect(data.success).toBe(true);
    expect(data.taskId).toBe(taskId);
  });

  it("routes /api/tasks/:id/status to the DO", async () => {
    const taskId = "route-test-start"; // Same DO as above
    // Wait a moment for the background agent to run
    await new Promise((r) => setTimeout(r, 2000));

    const res = await mf.dispatchFetch(
      `http://localhost/api/tasks/${taskId}/status`
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { task: any };
    expect(data.task).toBeTruthy();
  });

  it("routes /api/tasks/:id/steps to the DO", async () => {
    const res = await mf.dispatchFetch(
      `http://localhost/api/tasks/route-test-start/steps`
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { steps: unknown[] };
    expect(Array.isArray(data.steps)).toBe(true);
  });

  it("returns 404 for unmatched routes", async () => {
    const res = await mf.dispatchFetch("http://localhost/not-a-route");
    expect(res.status).toBe(404);
  });

  it("returns 405 for non-POST on /start", async () => {
    const res = await mf.dispatchFetch(
      "http://localhost/api/tasks/x/start",
      { method: "GET" }
    );
    expect(res.status).toBe(405);
  });
});

describe("Task from a GitHub issue", () => {
  beforeAll(() => {
    githubServer.issues.set("octo/widgets#7", {
      number: 7,
      title: "Widget count is off by one",
      body: "`count()` returns n+1 for empty lists.",
      html_url: "https://github.com/octo/widgets/issues/7",
    });
    githubServer.issues.set("octo/widgets#8", {
      number: 8,
      title: "A PR",
      html_url: "https://github.com/octo/widgets/pull/8",
      pull_request: { url: "x" },
    });
  });

  it("resolves {repo, issue} to the repo URL and an issue prompt", async () => {
    const taskId = "issue-task-001";
    const res = await startTask(taskId, { repo: "octo/widgets", issue: 7, ref: "main" });
    expect(res.status).toBe(200);

    const task = await waitForTask(taskId);
    expect(task).toMatchObject({
      repo_url: "https://github.com/octo/widgets",
      ref: "main",
      issue_number: 7,
      issue_url: "https://github.com/octo/widgets/issues/7",
    });
    expect(task.prompt).toContain("octo/widgets#7");
    expect(task.prompt).toContain("Widget count is off by one");
    expect(task.prompt).toContain("returns n+1 for empty lists");

    const create = modalServer.requests.find((r) => r.endpoint === "/session/create" && r.body.taskId === taskId);
    expect(create?.body).toMatchObject({ repo_url: "https://github.com/octo/widgets", ref: "main" });

    const gh = githubServer.requests.find((r) => r.path === "/repos/octo/widgets/issues/7");
    expect(gh?.headers["user-agent"]).toBe("gantry-control-plane");
    expect(gh?.headers.authorization).toBeUndefined();
  });

  it("accepts an issue URL", async () => {
    const taskId = "issue-task-002";
    expect((await startTask(taskId, { issue: "https://github.com/octo/widgets/issues/7" })).status).toBe(200);
    const task = await waitForTask(taskId);
    expect(task).toMatchObject({ issue_number: 7, ref: "HEAD" });
  });

  it.each([
    ["an unknown issue", { repo: "octo/widgets", issue: 999 }, 404],
    ["a pull request", { repo: "octo/widgets", issue: 8 }, 422],
    ["a malformed repo", { repo: "not a repo", issue: 7 }, 400],
    ["neither prompt nor issue", {}, 400],
    ["a repoUrl that contradicts the issue", { repo: "octo/widgets", issue: 7, repoUrl: "https://github.com/x/y" }, 400],
  ])("rejects %s without starting a task", async (_name, body, status) => {
    const taskId = `issue-reject-${status}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await startTask(taskId, body);
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
    const statusRes = await mf.dispatchFetch(`http://localhost/api/tasks/${taskId}/status`);
    expect(((await statusRes.json()) as { task: any }).task).toBeNull();
  });

  it("reports GitHub rate limiting as 503", async () => {
    githubServer.forceStatus = 403;
    try {
      const res = await startTask("issue-ratelimited", { repo: "octo/widgets", issue: 7 });
      expect(res.status).toBe(503);
    } finally {
      githubServer.forceStatus = null;
    }
  });
});

describe(".gantry.yml", () => {
  it("runs setup commands in order before the agent, and records the test command", async () => {
    const repoUrl = "https://github.com/example/with-config";
    modalServer.repoFiles.set(repoUrl, {
      ".gantry.yml": "setup:\n  - npm ci\n  - npm run build\ntest: npm test\nimage: node:22\n",
    });
    const taskId = "config-task-full";
    await startTask(taskId, { prompt: "fix it", repoUrl });
    const task = await waitForTask(taskId);

    expect(task).toMatchObject({ verification: "pending", test_command: "npm test" });
    const commands = sessionFor(taskId)!.commands;
    expect(commands.slice(0, 2)).toEqual(["npm ci", "npm run build"]);

    const stepsRes = await mf.dispatchFetch(`http://localhost/api/tasks/${taskId}/steps`);
    const { steps } = (await stepsRes.json()) as { steps: any[] };
    expect(steps.filter((r) => r.tool_name === "setup").map((r) => JSON.parse(r.tool_input).command))
      .toEqual(["npm ci", "npm run build"]);
  });

  it("marks the run unverified when the repo has no .gantry.yml", async () => {
    const taskId = "config-task-absent";
    await startTask(taskId, { prompt: "fix it", repoUrl: "https://github.com/example/no-config" });
    const task = await waitForTask(taskId);
    expect(task).toMatchObject({ verification: "unverified", test_command: null });
    expect(sessionFor(taskId)!.commands.filter((c) => c !== "git diff")).toEqual([]);
  });

  it("runs setup but stays unverified when .gantry.yml has no test:", async () => {
    const repoUrl = "https://github.com/example/setup-only";
    modalServer.repoFiles.set(repoUrl, { ".gantry.yml": "setup: pip install -e .\n" });
    const taskId = "config-task-no-test";
    await startTask(taskId, { prompt: "fix it", repoUrl });
    const task = await waitForTask(taskId);
    expect(task).toMatchObject({ verification: "unverified", test_command: null });
    expect(sessionFor(taskId)!.commands[0]).toBe("pip install -e .");
  });

  it("fails the task when a setup command fails, and still terminates the sandbox", async () => {
    const repoUrl = "https://github.com/example/broken-setup";
    modalServer.repoFiles.set(repoUrl, { ".gantry.yml": "setup:\n  - make deps\n  - never-runs\ntest: make test\n" });
    modalServer.commandResults.set("make deps", { exit_code: 2, stderr: "No rule to make target" });
    const taskId = "config-task-setup-fails";
    await startTask(taskId, { prompt: "fix it", repoUrl });
    const task = await waitForTask(taskId);
    expect(task.status).toBe("FAILED");
    const session = sessionFor(taskId)!;
    expect(session.commands).not.toContain("never-runs");
    expect(session.terminated).toBe(true);
  });

  it("fails the task on an invalid .gantry.yml", async () => {
    const repoUrl = "https://github.com/example/bad-config";
    modalServer.repoFiles.set(repoUrl, { ".gantry.yml": "test: [unclosed\n" });
    const taskId = "config-task-invalid";
    await startTask(taskId, { prompt: "fix it", repoUrl });
    const task = await waitForTask(taskId);
    expect(task.status).toBe("FAILED");
    expect(task.verification).toBeNull();
    expect(sessionFor(taskId)!.terminated).toBe(true);
  });
});

describe("Agent loop tools (mock Gemini)", () => {
  const repoUrl = "https://github.com/example/tools";
  const COUNT_PY = "def count(xs):\n    return len(xs) + 1\n";

  beforeAll(() => {
    modalServer.repoFiles.set(repoUrl, { "src/count.py": COUNT_PY });
  });

  async function stepsOf(taskId: string): Promise<any[]> {
    const res = await mf.dispatchFetch(`http://localhost/api/tasks/${taskId}/steps`);
    return ((await res.json()) as { steps: any[] }).steps;
  }

  it("reads, edits and diffs a file through the loop", async () => {
    const marker = "[loop-read-edit]";
    geminiServer.script(marker, [
      { toolCalls: [{ name: "readFile", args: { path: "src/count.py" } }] },
      {
        toolCalls: [{
          name: "editFile",
          args: { path: "src/count.py", edits: [{ oldText: "len(xs) + 1", newText: "len(xs)" }] },
        }],
      },
      { toolCalls: [{ name: "getDiff", args: {} }] },
      { text: "Fixed the off-by-one." },
    ]);
    const taskId = "loop-read-edit";
    await startTask(taskId, { prompt: `${marker} fix count`, repoUrl });
    const task = await waitForTask(taskId);

    expect(task.status).toBe("RESOLVED");
    expect(sessionFor(taskId)!.files.get("src/count.py")).toBe("def count(xs):\n    return len(xs)\n");

    const results = toolResultsIn(geminiServer.requestsFor(marker).at(-1)!);
    expect(results.map((r) => r.name)).toEqual(["readFile", "editFile", "getDiff"]);
    expect(results[0].result).toMatchObject({
      path: "src/count.py",
      content: "1: def count(xs):\n2:     return len(xs) + 1",
      totalLines: 2,
      truncated: false,
    });
    expect(results[1].result).toEqual({ path: "src/count.py", replacements: 1 });
    expect(results[2].result.patch).toContain("+    return len(xs)");

    expect((await stepsOf(taskId)).map((s) => s.tool_name)).toEqual(["readFile", "editFile", "getDiff"]);
  });

  it("writes a new file without reading it first", async () => {
    const marker = "[loop-write-new]";
    geminiServer.script(marker, [
      { toolCalls: [{ name: "writeFile", args: { path: "src/new.py", content: "X = 1\n" } }] },
    ]);
    const taskId = "loop-write-new";
    await startTask(taskId, { prompt: `${marker} add a file`, repoUrl });
    expect((await waitForTask(taskId)).status).toBe("RESOLVED");
    expect(sessionFor(taskId)!.files.get("src/new.py")).toBe("X = 1\n");
    const [write] = toolResultsIn(geminiServer.requestsFor(marker).at(-1)!);
    expect(write.result).toEqual({ path: "src/new.py", existed: false });
  });

  it.each([
    [
      "overwriting a file it hasn't read",
      { name: "writeFile", args: { path: "src/count.py", content: "oops\n" } },
      /must read file src\/count\.py before overwriting/,
    ],
    [
      "an edit whose oldText doesn't match",
      { name: "editFile", args: { path: "src/count.py", edits: [{ oldText: "no such text", newText: "x" }] } },
      /src\/count\.py/,
    ],
    [
      "reading a missing file",
      { name: "readFile", args: { path: "src/missing.py" } },
      /File not found: src\/missing\.py/,
    ],
  ])("returns {error} to the model for %s, and the task still resolves", async (name, call, message) => {
    const marker = `[loop-error-${name}]`;
    geminiServer.script(marker, [{ toolCalls: [call] }, { text: "Giving up." }]);
    const taskId = `loop-error-${call.name}`;
    await startTask(taskId, { prompt: `${marker} try it`, repoUrl });
    const task = await waitForTask(taskId);

    expect(task.status).toBe("RESOLVED");
    expect(sessionFor(taskId)!.files.has("src/count.py")).toBe(false);
    const [result] = toolResultsIn(geminiServer.requestsFor(marker).at(-1)!);
    expect(result.name).toBe(call.name);
    expect(result.result.error).toMatch(message);

    const [step] = await stepsOf(taskId);
    expect(step.tool_name).toBe(call.name);
    expect(JSON.parse(step.tool_output).error).toMatch(message);
  });

  it("offers runTests only when .gantry.yml declares a test command, and returns its result", async () => {
    const withTests = "https://github.com/example/tools-with-tests";
    modalServer.repoFiles.set(withTests, { ".gantry.yml": "test: pytest -q\n" });
    modalServer.commandResults.set("pytest -q", { exit_code: 1, stdout: "1 failed" });
    const marker = "[loop-run-tests]";
    geminiServer.script(marker, [{ toolCalls: [{ name: "runTests", args: {} }] }]);
    const taskId = "loop-run-tests";
    await startTask(taskId, { prompt: `${marker} run them`, repoUrl: withTests });
    expect((await waitForTask(taskId)).status).toBe("RESOLVED");

    const requests = geminiServer.requestsFor(marker);
    expect(JSON.stringify(requests[0].body.tools)).toContain("runTests");
    const [result] = toolResultsIn(requests.at(-1)!);
    expect(result).toMatchObject({ name: "runTests", result: { exit_code: 1, stdout: "1 failed" } });

    // A repo without a test command never sees the tool.
    const [plain] = geminiServer.requestsFor("[loop-write-new]");
    expect(JSON.stringify(plain.body.tools)).not.toContain("runTests");
  });

  it("fails the task when the model call fails, and still terminates the sandbox", async () => {
    const marker = "[loop-llm-error]";
    // The AI SDK doesn't retry a 400, so the failure is immediate.
    geminiServer.script(marker, [{ status: 400 }]);
    const taskId = "loop-llm-error";
    await startTask(taskId, { prompt: `${marker} anything`, repoUrl });
    const task = await waitForTask(taskId);
    expect(task.status).toBe("FAILED");
    expect(sessionFor(taskId)!.terminated).toBe(true);
  });
});

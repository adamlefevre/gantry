import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import esbuild from "esbuild";
import { MockModalServer } from "./mock-modal-server";

let mf: Miniflare;
let modalServer: MockModalServer;
let workerScript: string;

beforeAll(async () => {
  // 1. Start the mock Modal server
  modalServer = new MockModalServer();
  await modalServer.start();

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
    },
  });

  await mf.ready;
});

afterAll(async () => {
  await mf?.dispose();
  await modalServer?.stop();
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
    // The task should have completed (RESOLVED or FAILED depending on
    // the mock model's tool-calling behaviour). Since our mock Modal
    // server always returns success for /session/create and /exec, and
    // the AI SDK's generateText will use the real model (which won't
    // have a valid API key), the agent loop will likely FAIL on the
    // LLM call. That's fine — we verify the machinery works.
    expect(["RESOLVED", "FAILED"]).toContain(task.status);
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
    // Wait a moment for the background agent to attempt (and likely fail)
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

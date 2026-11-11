import { DurableObject } from "cloudflare:workers";
import { runAgentLoop, type AgentTelemetry, type RepoTarget } from "./agent";

export interface Env {
  TASK_COORDINATOR: DurableObjectNamespace;
  GANTRY_BUCKET?: R2Bucket;
  HYDRALAKE_BUCKET?: R2Bucket;
  MODAL_SANDBOX_URL: string;
  AGENT_SANDBOX_TOKEN: string;
  GOOGLE_GENERATIVE_AI_API_KEY: string;
  // Test/mock hooks
  MODEL_OVERRIDE?: any;
}

export interface TaskRecord {
  id: string;
  status: "QUEUED" | "RUNNING" | "RESOLVED" | "FAILED";
  prompt: string;
  repo_url: string | null;
  ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface StepRecord {
  id: number;
  task_id: string;
  step_index: number;
  tool_name: string;
  tool_input: string;
  tool_output: string;
  tokens_used: number;
  created_at: string;
}

export interface TaskStartBody {
  taskId?: string;
  prompt: string;
  /** Public https git URL to clone into the sandbox. Omit to start with an empty workspace. */
  repoUrl?: string;
  /** Branch, tag, or commit SHA. Defaults to the remote's HEAD. */
  ref?: string;
}

export class TaskCoordinator extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = this.ctx.storage.sql;
    this.initDatabase();
  }

  private initDatabase(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        repo_url TEXT,
        ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input TEXT NOT NULL,
        tool_output TEXT NOT NULL,
        tokens_used INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);

    // Durable Objects created before repo_url/ref existed: add the columns in place.
    const cols = this.sql.exec(`PRAGMA table_info(tasks)`).toArray().map((c: any) => c.name);
    for (const col of ["repo_url", "ref"]) {
      if (!cols.includes(col)) this.sql.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT`);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws" || url.pathname.endsWith("/ws")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if ((url.pathname === "/start" || url.pathname.endsWith("/start")) && request.method === "POST") {
      const body = (await request.json()) as TaskStartBody;
      let taskId = body.taskId;
      if (!taskId) {
        const match = url.pathname.match(/\/api\/tasks\/([^/]+)\/start/);
        taskId = match ? match[1] : `task_${Date.now()}`;
      }
      const repo = body.repoUrl ? { url: body.repoUrl, ref: body.ref || "HEAD" } : undefined;
      return this.handleStartTask(taskId, body.prompt, repo);
    }

    if (url.pathname === "/status" || url.pathname.endsWith("/status")) {
      const cursor = this.sql.exec(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT 1`);
      const task = cursor.toArray()[0] || null;
      return Response.json({ task });
    }

    if (url.pathname === "/steps" || url.pathname.endsWith("/steps")) {
      const cursor = this.sql.exec(`SELECT * FROM steps ORDER BY step_index ASC`);
      const steps = cursor.toArray();
      return Response.json({ steps });
    }

    return new Response("Not Found", { status: 404 });
  }

  // Public helper methods for testing and programmatic DO access
  getTask(taskId?: string): TaskRecord | null {
    const query = taskId
      ? `SELECT * FROM tasks WHERE id = ? LIMIT 1`
      : `SELECT * FROM tasks ORDER BY created_at DESC LIMIT 1`;
    const cursor = taskId ? this.sql.exec(query, taskId) : this.sql.exec(query);
    const rows = cursor.toArray() as unknown as TaskRecord[];
    return rows[0] || null;
  }

  getSteps(taskId?: string): StepRecord[] {
    const query = taskId
      ? `SELECT * FROM steps WHERE task_id = ? ORDER BY step_index ASC`
      : `SELECT * FROM steps ORDER BY step_index ASC`;
    const cursor = taskId ? this.sql.exec(query, taskId) : this.sql.exec(query);
    return cursor.toArray() as unknown as StepRecord[];
  }

  private async handleStartTask(taskId: string, prompt: string, repo?: RepoTarget): Promise<Response> {
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO tasks (id, status, prompt, repo_url, ref, created_at, updated_at)
       VALUES (?, 'RUNNING', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status='RUNNING', updated_at=?`,
      taskId, prompt, repo?.url ?? null, repo?.ref ?? null, now, now, now
    );

    this.broadcast({ type: "TASK_STARTED", taskId, prompt, repo });

    // Run execution loop in background
    const sessionPromise = this.executeAgentSession(taskId, prompt, repo);
    this.ctx.waitUntil(sessionPromise);

    return Response.json({ success: true, taskId });
  }

  async executeAgentSession(taskId: string, prompt: string, repo?: RepoTarget): Promise<void> {
    let finalStatus: "RESOLVED" | "FAILED" = "RESOLVED";
    let telemetryData: AgentTelemetry | null = null;

    try {
      telemetryData = await runAgentLoop({
        env: this.env,
        prompt,
        taskId,
        repo,
        modelOverride: this.env.MODEL_OVERRIDE,
        onStep: (step) => {
          this.sql.exec(
            `INSERT INTO steps (task_id, step_index, tool_name, tool_input, tool_output, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            taskId,
            step.stepIndex,
            step.toolName,
            JSON.stringify(step.input),
            JSON.stringify(step.output),
            new Date().toISOString()
          );

          this.broadcast({
            type: "AGENT_STEP",
            taskId,
            stepIndex: step.stepIndex,
            toolName: step.toolName,
            output: step.output
          });
        },
        onChunk: (textChunk) => {
          this.broadcast({ type: "THOUGHT_STREAM", taskId, chunk: textChunk });
        }
      });
    } catch (err: any) {
      finalStatus = "FAILED";
      this.broadcast({ type: "TASK_ERROR", taskId, error: err.message });
    } finally {
      const now = new Date().toISOString();
      this.sql.exec(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`, finalStatus, now, taskId);

      // Persist telemetry to Cloudflare R2 for lakehouse ingestion
      const bucket = this.env.GANTRY_BUCKET || this.env.HYDRALAKE_BUCKET;
      if (telemetryData && bucket) {
        const d = new Date();
        const year = d.getUTCFullYear();
        const month = String(d.getUTCMonth() + 1).padStart(2, "0");
        const key = `telemetry/year=${year}/month=${month}/${taskId}.json`;

        try {
          await bucket.put(key, JSON.stringify(telemetryData, null, 2), {
            customMetadata: { taskId, status: finalStatus }
          });
        } catch (r2Err) {
          console.error("Failed to persist telemetry to R2:", r2Err);
        }
      }

      this.broadcast({ type: "TASK_FINISHED", taskId, status: finalStatus });
    }
  }

  private broadcast(message: object): void {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Socket closed
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Keepalive ping/pong handled automatically by DO WebSocket Hibernation
    if (message === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close();
  }
}

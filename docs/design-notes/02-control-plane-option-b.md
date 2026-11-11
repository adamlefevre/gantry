# Design notes 02: control plane "Option B"

Condensed from a Gemini session ("HydraLake Control Plane Architecture"). This is historical context. Code listings are left out: `apps/control-plane/` and `services/execution-sandbox/` hold newer versions of them.

> Naming note: in that session, "Option B" meant the architecture below. It is **not** the same as the "option B" offered later in a Claude session (running an existing headless coding agent). That one was rejected. See ADR 0001, decision 1.

## The decision

**Cloudflare Durable Objects + Vercel AI SDK + Modal sandboxes as a dumb execution layer.**

- **Durable Object (`TaskCoordinator`):** owns the task state machine, stores task and step history in SQLite, and streams progress over WebSocket.
- **Vercel AI SDK (TypeScript, on Workers):** drives the agent's tool loop.
- **Modal:** a FastAPI service around isolated sandboxes that runs bash, pytest and git commands on demand.
- **R2:** stores code artifacts and telemetry, compacted daily by DuckDB.

## Notes on integration patterns

- **Durable Object SQLite:**
  - `this.ctx.storage.sql` runs queries synchronously inside the Durable Object.
  - The SQLite class must be declared in `wrangler.jsonc` `migrations` (`new_sqlite_classes`, tag `v1`).
- **AI SDK on Workers:**
  - `ai` and `@ai-sdk/google` use web-standard `fetch`, streams and crypto, which run natively on workerd.
  - Enable `nodejs_compat` for buffer and crypto interop.
- **Sandbox lifecycle:** Modal bills sandboxes per second. So the Durable Object:
  - creates the sandbox when the task starts;
  - reuses that one session ID for every step of the loop (`maxSteps`);
  - always terminates it in a `finally`.
- **WebSocket hibernation:** `ctx.acceptWebSocket()` lets the Durable Object sleep while it waits on clients or long sandbox steps, instead of burning CPU.

## What the session specified

- `wrangler.jsonc`:
  - `TASK_COORDINATOR` Durable Object binding;
  - SQLite migration `v1`;
  - R2 binding (originally `HYDRALAKE_BUCKET`, now `GANTRY_BUCKET`, with the old name still accepted);
  - `MODAL_SANDBOX_URL` var.
- `TaskCoordinator.ts`:
  - SQLite tables `tasks` and `steps`;
  - routes `/ws`, `/start` and `/status`;
  - runs the agent in the background via `ctx.waitUntil`;
  - broadcasts `TASK_STARTED`, `AGENT_STEP`, `THOUGHT_STREAM`, `TASK_ERROR` and `TASK_FINISHED`;
  - writes telemetry JSON to `telemetry/year=YYYY/month=MM/<taskId>.json` for the lakehouse to ingest.
- `agent.ts`:
  - `generateText` with `gemini-2.5-flash` and `maxSteps: 8`;
  - tools `runCommand`, `writeFile`, `readFile` and `getDiff`;
  - calls `/session/create` before the loop and `/session/terminate` in a `finally`;
  - returns `AgentTelemetry` (`taskId`, `model`, `totalTokens`, `stepsCount`, `patch`, `completedAt`).
- Local testing:
  - a mock Modal HTTP server implementing the five sandbox endpoints;
  - an end-to-end Vitest + Miniflare test that checks SQLite inserts, WebSocket broadcasts and sandbox termination.

## How it diverged (status as of 2026-11-10)

- The session's `agent.ts` called `/file/read`, which the sandbox service didn't have. It also sent `sessionId` while the service expected `sandbox_id`. Both are fixed: the contract now accepts both keys, and `/file/read` exists.
- Tasks can now target any repo: the `/start` body takes `repoUrl` and `ref`, and the sandbox clones the repo into `/workspace`. See ADR 0001.

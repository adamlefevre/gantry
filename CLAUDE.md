# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

AGENTS.md (imported above) holds the architecture summary, safety rules, and issue-tracker/triage/domain-doc conventions. This file adds what you need to work in the code.

## Commands

Python side (run from repo root; `pytest.ini` sets `pythonpath = .` so `from pipelines.compact import ...` works). A local `.venv` is used; deps are in `requirements.txt`. The Makefile uses `SHELL := /bin/bash` and `-include .env`, so on Windows run it from Git Bash.

- `make test` → `pytest tests/test_compaction.py -v -s`. **This hits real Cloudflare R2**: it needs `.env` populated (`CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`). There are no offline Python tests.
- Single test: `pytest tests/test_compaction.py::<test_name> -v -s`
- `make ingest` / `make compact` run `pipelines/ingest.py` / `pipelines/compact.py` against the real bucket. `compact` **deletes** source files after it compacts them.
- `make modal-test` runs the cron job once on Modal (`modal run`). `make modal-deploy` deploys both Modal apps.
- `make init-bucket`, `make cors`, `make clean` (deletes the bucket) go through `npx wrangler r2 ...`.

TypeScript control plane (npm workspaces; root `package.json` workspaces = `apps/*`):

- `npm test` (root) or `npm --prefix apps/control-plane run test` → `vitest run`. Fully offline: Miniflare plus a mock Modal HTTP server.
- Single test: `cd apps/control-plane && npx vitest run -t "<test name substring>"`
- `npm --prefix apps/control-plane run dev` / `deploy` → `wrangler dev` / `wrangler deploy`
- Type-check: `cd apps/control-plane && npx tsc --noEmit` (there's no lint script)

CI (`.github/workflows/ci.yml`) runs only the Python R2 integration test on Python 3.11, using repo secrets. It does not run the TypeScript tests.

## Architecture

### Lakehouse (Python)
- R2 is accessed two ways: **DuckDB** `httpfs` with a `TYPE R2` secret, reading and writing `r2://<bucket>/...` URLs, and **boto3** against `https://<account>.r2.cloudflarestorage.com` for listing and deletes. `pipelines/compact.py` exposes `get_s3_client()` and `init_duckdb()`, and the Modal job and the tests both reuse them.
- Data layout: Hive-style partitions under `data/` (e.g. `data/year=2024/month=01/`). Telemetry from the control plane lands in `telemetry/year=YYYY/month=MM/<taskId>.json`.
- Compaction flow: `discover_small_files` (parquet files <32MB, grouped by directory, skipping `compacted-*` files) → `pack_batches` (greedy, up to 128MB) → `compact_partition_batch`. That last step writes `compacted-<id>.parquet` with SNAPPY compression and ~120k-row row groups, checks that row counts match, and then deletes the source files. It skips batches with fewer than 2 files.
- `compact.py` reads env vars into module-level globals **at import time**, after `load_dotenv()`. Set env before importing it.
- `jobs/scheduled_compaction.py` is a Modal app (`gantry-maintenance`) with a daily cron at 02:00 UTC. It bundles `pipelines/` through `add_local_python_source` and reads credentials from the Modal secret `r2-credentials`. It repeats the `compact.main()` loop instead of calling it, so keep the two in sync.
- `tests/test_compaction.py` uses a module-scoped autouse fixture. It writes 5 synthetic micro-files to `data/test_runs/run_<uuid>`, runs compaction, checks parity, and deletes the prefix on teardown.

### Control plane (TypeScript, `apps/control-plane`)
- Request flow: `src/index.ts` (Worker router) → `TaskCoordinator` Durable Object, one per task via `idFromName(taskId)` → `runAgentLoop` in `src/agent.ts` → Modal sandbox HTTP API.
- Routes: `POST /api/tasks/:id/start`, `GET /api/tasks/:id/{status,steps,ws}`. The router rewrites each to a bare DO path (`/start`, `/status`, ...) before forwarding.
- `TaskCoordinator` uses DO SQLite (tables `tasks` and `steps`, migration tag `v1` in `wrangler.jsonc`) and hibernatable WebSockets to broadcast `TASK_STARTED` / `AGENT_STEP` / `THOUGHT_STREAM` / `TASK_ERROR` / `TASK_FINISHED`. It runs the agent session in `ctx.waitUntil` and writes telemetry JSON to the `GANTRY_BUCKET` R2 binding.
- `agent.ts` uses Vercel AI SDK `generateText` with `gemini-2.5-flash` (`@ai-sdk/google`, env `GOOGLE_GENERATIVE_AI_API_KEY`) and `maxSteps: 8`. Its tools are `runCommand`, `writeFile`, `readFile`, `getDiff`. It calls `/session/create` before the loop and `/session/terminate` in a `finally`. `env.MODEL_OVERRIDE` lets tests inject a mock model.
- Sandbox wire contract: the agent sends both `sessionId` and `sandbox_id` with a `Bearer AGENT_SANDBOX_TOKEN` header, and accepts either key from `/session/create`. Endpoints: `/session/create`, `/exec`, `/file/write`, `/file/read`, `/session/terminate`. If you change the contract, update `services/execution-sandbox/service.py`, `agent.ts`, and `tests/mock-modal-server.ts` together.
- Tests (`apps/control-plane/tests/control-plane.test.ts`) bundle `src/index.ts` with esbuild (`cloudflare:workers` external) and load it into Miniflare with DO + R2 bindings. The mock Modal server lives at the repo root, `tests/mock-modal-server.ts`, and is re-exported from `apps/control-plane/tests/mock-modal-server.ts`.

### Execution sandbox (`services/execution-sandbox/service.py`)
- Modal app `agent-sandbox-service`: a FastAPI app served via `@modal.asgi_app()`. It authenticates against the Modal secret `agent-sandbox-secret` (rejects all requests if unset), creates `modal.Sandbox` instances (Debian, Python 3.11, with pytest/ruff/duckdb/boto3) and re-attaches to them with `Sandbox.from_id`.
- `/session/create` takes optional `{repo_url, ref}` (public `https://` only for now; `ref` is a branch, tag or SHA, default `HEAD`) and shallow-fetches it into `/workspace`. Every later command and file path runs relative to `/workspace`. If the checkout fails, it terminates the sandbox and returns a 422.
- Untrusted input never goes through a shell, except the agent's own `/exec` command: git, `cat` and the file-write helper get argv, and file content goes over stdin.
- A task carries the repo as `repoUrl`/`ref` in the `/start` body. They're stored on the `tasks` row and forwarded to `/session/create`.
- Design direction (our own Vercel AI SDK agent loop, GitHub App, red-green verification, `.gantry.yml`): `docs/adr/0001-software-factory-for-any-repo.md`.

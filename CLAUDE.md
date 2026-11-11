# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

AGENTS.md (imported above) holds the architecture summary, safety rules, and issue-tracker/triage/domain-doc conventions. This file adds what you need to work in the code.

## Commands

TypeScript control plane (npm workspaces; root `package.json` workspaces = `apps/*`). The Makefile wraps these (`make test`, `typecheck`, `dev`, `deploy`, `modal-deploy`); it uses `SHELL := /bin/bash`, so on Windows run it from Git Bash.

- `npm test` (root) or `npm --prefix apps/control-plane run test` → `vitest run`. Fully offline: Miniflare plus mock Modal and GitHub HTTP servers.
- Single test: `cd apps/control-plane && npx vitest run -t "<test name substring>"`
- `npm --prefix apps/control-plane run dev` / `deploy` → `wrangler dev` / `wrangler deploy`
- Type-check: `cd apps/control-plane && npx tsc --noEmit` (there's no lint script)
- `make modal-deploy` deploys the execution sandbox (`modal deploy services/execution-sandbox/service.py`); `requirements.txt` holds the Python deps for that.

CI (`.github/workflows/ci.yml`) runs the type-check and the offline tests on Node 22. It needs no secrets.

The lakehouse (R2 ingest, compaction, the Modal cron) lives in the separate gantry-lakehouse repo (ADR 0003). The only link is the telemetry the control plane writes to R2; its shape and path are the contract in `docs/telemetry.md`. If you change `AgentTelemetry` or the telemetry key, update that file and bump its version.

## Architecture

### Control plane (TypeScript, `apps/control-plane`)
- Request flow: `src/index.ts` (Worker router) → `TaskCoordinator` Durable Object, one per task via `idFromName(taskId)` → `runAgentLoop` in `src/agent.ts` → Modal sandbox HTTP API.
- Routes: `POST /api/tasks/:id/start`, `GET /api/tasks/:id/{status,steps,ws}`. The router rewrites each to a bare DO path (`/start`, `/status`, ...) before forwarding.
- `/start` takes an **issue task** (`{repo: "owner/name", issue: 12}` or `{issue: "<github issue URL>"}`, optional `ref` and `prompt`) or a **prompt task** (`{prompt, repoUrl?, ref?}`). `src/taskInput.ts` resolves it inside the DO; `src/github.ts` fetches the issue from the unauthenticated GitHub REST API (`GITHUB_API_URL` overrides the base, `GITHUB_TOKEN` is the seam for the step-3 App token) and fences the issue text into the prompt. Bad input returns 400/404/422/503 and creates no task row.
- `TaskCoordinator` uses DO SQLite (tables `tasks` and `steps`, migration tag `v1` in `wrangler.jsonc`; new `tasks` columns go in the `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` list in `initDatabase`) and hibernatable WebSockets to broadcast `TASK_STARTED` / `AGENT_STEP` / `THOUGHT_STREAM` / `TASK_CONFIG` / `TASK_ERROR` / `TASK_FINISHED`. It runs the agent session in `ctx.waitUntil` and writes telemetry JSON to the `GANTRY_BUCKET` R2 binding.
- `agent.ts` uses Vercel AI SDK `generateText` with `gemini-2.5-flash` (`@ai-sdk/google`, env `GOOGLE_GENERATIVE_AI_API_KEY`) and `maxSteps: MAX_AGENT_STEPS` (16). Its tools are `runCommand`, `readFile` (paged, line-numbered), `editFile` (exact-text replacement), `writeFile` (an existing file must be read first), `getDiff`, plus `runTests` when the repo declares a test command. The file tools live in `src/tools/` (adapted from eve; see `NOTICE`) and return errors to the model as `{error}`, since a thrown tool error aborts an AI SDK v4 loop. It calls `/session/create`, then reads `.gantry.yml` via `/file/read` (404 = absent), parses it in the Worker (`src/gantryConfig.ts`, ADR 0002), runs each `setup` command through `/exec` (non-zero exit fails the task), and only then starts the loop. `/session/terminate` runs in a `finally`.
- A task's `verification` is `unverified` (no `test:`; draft PRs only) or `pending` (step 4's red-green verification will decide). It's null until `.gantry.yml` has been read. See `GLOSSARY.md`. `env.MODEL_OVERRIDE` lets tests inject a mock model.
- Sandbox wire contract: the agent sends both `sessionId` and `sandbox_id` with a `Bearer AGENT_SANDBOX_TOKEN` header, and accepts either key from `/session/create`. Endpoints: `/session/create`, `/exec`, `/file/write`, `/file/read`, `/session/terminate`. If you change the contract, update `services/execution-sandbox/service.py`, `agent.ts`, and `tests/mock-modal-server.ts` together.
- Tests (`apps/control-plane/tests/control-plane.test.ts`) bundle `src/index.ts` with esbuild (`cloudflare:workers` external) and load it into Miniflare with DO + R2 bindings. The mock Modal server lives at the repo root, `tests/mock-modal-server.ts`, and is re-exported from `apps/control-plane/tests/mock-modal-server.ts`.

### Execution sandbox (`services/execution-sandbox/service.py`)
- Modal app `agent-sandbox-service`: a FastAPI app served via `@modal.asgi_app()`. It authenticates against the Modal secret `agent-sandbox-secret` (rejects all requests if unset), creates `modal.Sandbox` instances (Debian, Python 3.11, git, pytest and ruff; anything else a target repo needs comes from its `.gantry.yml` `setup:`) and re-attaches to them with `Sandbox.from_id`.
- `/session/create` takes optional `{repo_url, ref}` (public `https://` only for now; `ref` is a branch, tag or SHA, default `HEAD`) and shallow-fetches it into `/workspace`. Every later command and file path runs relative to `/workspace`. If the checkout fails, it terminates the sandbox and returns a 422.
- Untrusted input never goes through a shell, except the agent's own `/exec` command: git, `head` (for `/file/read`, capped at 1 MiB) and the file-write helper get argv, and file content goes over stdin.
- The resolved repo URL and `ref` are stored on the `tasks` row and forwarded to `/session/create`. Sandboxes live up to 30 minutes; `/exec` accepts `timeout_seconds` up to 900 (setup and test commands use 600).
- Design direction (our own Vercel AI SDK agent loop, GitHub App, red-green verification, `.gantry.yml`): `docs/adr/0001-software-factory-for-any-repo.md`.

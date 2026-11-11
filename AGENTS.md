# Project Context: Gantry, a software factory

## Architecture & Goals
Gantry is an open-source agentic software factory: label an issue in any GitHub repo and get back a verified PR.
1. **Control plane:** a TypeScript Cloudflare Worker with one Durable Object per task. It runs our own coding-agent loop (Vercel AI SDK) and streams progress over WebSockets.
2. **Execution sandbox:** a Modal FastAPI service that creates an isolated sandbox per task, with the target repo checked out. It is a dumb execution layer.
3. **Verification:** the factory, not the agent, decides whether a change works (red-green, driven by the target repo's `.gantry.yml`). See `docs/adr/0001-software-factory-for-any-repo.md`.
4. **Telemetry:** every task writes a telemetry record to R2. The lakehouse that stores and compacts it lives in a separate repo, [gantry-lakehouse](https://github.com/adamlefevre/gantry-lakehouse), which is also the factory's first target repo. The record and path layout are a versioned contract: `docs/telemetry.md`. See `docs/adr/0003-lakehouse-in-its-own-repo.md`.
5. **CI/CD:** GitHub Actions runs the type-check and the offline control-plane tests.

## Repository Layout
```text
gantry/
├── apps/
│   └── control-plane/             # TypeScript: Cloudflare Worker + Durable Object
│       ├── wrangler.jsonc
│       ├── src/
│       │   ├── index.ts           # Worker router: /api/tasks/:id/{start,status,steps,ws}
│       │   ├── TaskCoordinator.ts # Durable Object: task state (SQLite), WebSockets, telemetry
│       │   └── agent.ts           # Agent loop (Vercel AI SDK) calling the sandbox API
│       └── tests/                 # Offline Vitest + Miniflare tests
├── services/
│   └── execution-sandbox/
│       └── service.py             # Modal FastAPI app: per-task sandboxes with the target repo cloned
├── tests/
│   └── mock-modal-server.ts       # Mock sandbox API used by the control-plane tests
├── docs/
│   ├── adr/                       # Architecture decision records
│   ├── agents/                    # Issue tracker, triage labels, domain-doc conventions
│   ├── design-notes/              # Historical design context
│   └── telemetry.md               # Telemetry contract with gantry-lakehouse
├── GLOSSARY.md                    # Domain vocabulary
├── Makefile                       # Central orchestrator
├── .env.example                   # Template for secrets
└── AGENTS.md                      # Agent context & instructions
```

## Safety & Compliance Rules
- NEVER hardcode secrets or corporate identifiers.
- Worker secrets go through `wrangler secret put` (or `.dev.vars` locally); sandbox secrets through `modal.Secret`. Model API keys stay in the Worker and never reach the sandbox.
- The control plane writes to R2 only through the `GANTRY_BUCKET` binding, and only under `telemetry/` (see `docs/telemetry.md`).
- Target-repo content (issues, `.gantry.yml`, code) is untrusted. It runs only inside the sandbox.
- Tests stay offline: Miniflare plus the mock Modal, GitHub and Gemini servers. No test may call a real external service.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `adamlefevre/gantry` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

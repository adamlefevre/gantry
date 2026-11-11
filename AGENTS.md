# Project Context: Gantry & Modal Agent Harness

## Architecture & Goals
This project is an open-source, serverless lakehouse and agentic software factory reference implementation:
1. **Storage Layer:** Cloudflare R2 (S3-compatible via DuckDB `httpfs`). Zero egress, snappy Parquet files.
2. **Compute:** DuckDB querying Hive-partitioned Parquet directly over S3 range requests. (No catalog yet; DuckLake is a possible future addition.)
3. **Scheduled Maintenance:** Serverless containerized compaction and cleanup running on **Modal** (daily cron, zero idle cost).
4. **CI/CD:** GitHub Actions running PyTest integration tests against ephemeral test namespaces (`data/test_runs/run_<uuid>`).
5. **Software Factory Execution:** A TypeScript control plane on Cloudflare Workers (one Durable Object per task) runs a coding agent against a target repo checked out in an isolated Modal sandbox. Direction: work on any repo's issues, with factory-enforced red-green verification. See `docs/adr/0001-software-factory-for-any-repo.md`.

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
├── pipelines/
│   ├── ingest.py                  # Ingests public NYC Taxi parquet to Cloudflare R2
│   └── compact.py                 # Bin-packs small files into ~128MB Parquet
├── services/
│   └── execution-sandbox/
│       └── service.py             # Modal FastAPI app: per-task sandboxes with the target repo cloned
├── jobs/
│   └── scheduled_compaction.py    # Modal cron app for automated daily maintenance
├── tests/
│   ├── test_compaction.py         # Ephemeral R2 integration test verifying compaction parity
│   └── mock-modal-server.ts       # Mock sandbox API used by the control-plane tests
├── docs/
│   ├── adr/                       # Architecture decision records
│   └── agents/                    # Issue tracker, triage labels, domain-doc conventions
├── Makefile                       # Central orchestrator
├── .env.example                   # Template for secrets
└── AGENTS.md                      # Agent context & instructions
```

## Safety & Compliance Rules
- NEVER hardcode secrets or corporate identifiers.
- Read credentials strictly from `.env` using `python-dotenv` locally and `modal.Secret` in remote jobs.
- All R2 writes must be confined to the configured bucket (`R2_BUCKET_NAME`).
- Always run tests against ephemeral prefixes (`data/test_runs/run_<uuid>`) and ensure fixtures clean up after themselves.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `adamlefevre/gantry` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

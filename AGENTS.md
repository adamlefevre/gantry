# Project Context: Gantry & Modal Agent Harness

## Architecture & Goals
This project is an open-source, serverless lakehouse and agentic software factory reference implementation:
1. **Storage Layer:** Cloudflare R2 (S3-compatible via DuckDB `httpfs`). Zero egress, snappy Parquet files.
2. **Compute & Catalog:** DuckDB + DuckLake querying partitioned Parquet directly over S3 range requests.
3. **Scheduled Maintenance:** Serverless containerized compaction and cleanup running on **Modal** (daily cron, zero idle cost).
4. **CI/CD:** GitHub Actions running PyTest integration tests against ephemeral test namespaces (`data/test_runs/run_<uuid>`).
5. **Software Factory Execution:** Vercel AI SDK on Cloudflare Workers / TypeScript control plane dispatching isolated test execution to Modal sandboxes.

## Repository Layout
```text
gantry/
├── apps/
│   └── control-plane/             # TypeScript: Cloudflare Worker / Vercel AI SDK
│       ├── package.json
│       ├── wrangler.jsonc
│       └── src/
│           └── agent.ts           # Vercel AI SDK agent dispatching to Modal
├── pipelines/
│   ├── ingest.py                  # Ingests public NYC Taxi parquet to Cloudflare R2
│   └── compact.py                 # Bin-packs small files into ~128MB Parquet
├── services/
│   └── execution-sandbox/
│       └── service.py             # Modal FastAPI app wrapping isolated Modal Sandboxes
├── jobs/
│   └── scheduled_compaction.py    # Modal cron app for automated daily maintenance
├── tests/
│   └── test_compaction.py         # Ephemeral integration test verifying compaction parity
├── Makefile                       # Central orchestrator
├── .env.example                   # Template for secrets
└── AGENTS.md                      # Agent context & instructions
```

## Safety & Compliance Rules
- NEVER hardcode secrets or corporate identifiers.
- Read credentials strictly from `.env` using `python-dotenv` locally and `modal.Secret` in remote jobs.
- All R2 writes must be confined to the configured bucket (`R2_BUCKET_NAME`).
- Always run tests against ephemeral prefixes (`data/test_runs/run_<uuid>`) and ensure fixtures clean up after themselves.

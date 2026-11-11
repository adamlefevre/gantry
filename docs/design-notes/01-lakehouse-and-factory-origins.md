# Design notes 01: lakehouse and software factory origins

Condensed from a Gemini session ("Showcasing Proprietary Tech Safely on GitHub"). This is historical context. The project was then called HydraLake. Code listings from the session are left out because the repo now holds newer versions of them. Where a decision changed later, it's marked **Later:**.

## Orchestration: GitHub Actions vs. a scheduler

- **GitHub Actions** handles CI only: it runs `pytest` against ephemeral partitions on PRs and pushes. Don't use it as a production cron. Its retries are weak, shared runners queue up, and minutes are billed.
- **Modal** runs scheduled maintenance (compaction). It uses real cron, scales to $0 when idle, and starts fast.
- Also considered:
  - Cloudflare Workers cron triggers, which can't run heavy DuckDB.
  - Prefect/Dagster, which are overkill for two tasks.

## Secrets: tiered strategy

- **Local:** `.env`, gitignored. Better is `direnv` or the 1Password CLI (`op run -- python ...`), so keys never touch disk.
- **CI:** GitHub Actions secrets, using an **R2-scoped token**: object read/write on the one bucket only, with no rights to delete the bucket or change lifecycle rules.
- **Production:** Modal secrets for jobs. Cloudflare secrets for Workers.
- CI skips fork PRs, which don't have the repo's secrets.

## Comparing agent harnesses within a Cloudflare architecture

| Option | Fit |
|---|---|
| Vercel AI SDK | Built for edge runtimes and runs on Workers. Bring your own sandbox. Best for streaming, UI and gateways. |
| LangGraph | Explicit state graphs and checkpoints. Heavy dependencies, so better hosted on Modal or Fly. Best for multi-role DAGs. |
| Warp / Cline / Aider / Goose | Local developer tools, not backend pipelines. |
| E2B / Modal / Daytona | Sandboxes. Required infrastructure, since Workers have no bash, no filesystem and short wall-clock limits. |

The chosen pattern is a **split plane**:
- **Cloudflare control plane:** Workers take in webhooks, Durable Objects or D1 hold task state, and R2 holds patches, artifacts and logs.
- **Execution plane on Modal:** a disposable Linux sandbox per session.

## Why sandbox code execution at all

1. **Blast radius.**
   - Prompt injection through an untrusted issue or PR body.
   - Hallucinated destructive commands.
   - The code under test must never see the orchestrator's API keys.
2. **Environment pollution.**
   - Every task starts from a clean snapshot.
   - Concurrent runs don't collide.
3. **Runaway execution.**
   - Hard CPU, memory and time limits.
   - A hung test kills only the sandbox.

The stack is **Vercel AI SDK as the brain and the sandbox API as the hands.** Benefits:
- an iterative test-repair loop (`maxSteps`);
- agent progress streamed to a UI;
- reproducible output: a `git diff` patch saved to R2, then the sandbox is destroyed.

**Decision: use Modal for the sandbox.** The same platform then runs both lakehouse maintenance and the agent sandboxes. The sandbox is a FastAPI service wrapping `modal.Sandbox`, called by the AI SDK tools over authenticated HTTP. **Later:** the hardcoded token, the shell-interpolated file writes and the query-string terminate were fixed in `services/execution-sandbox/service.py`.

## Naming

Candidates: HydraLake, Caldera, Quarry, TernLake, ForgeLake, PatchBay, and **Gantry** ("the crane structure that supports and moves heavy factory equipment"). Gantry was recommended if the agent factory is the headline. **Later:** the project is named Gantry.

## Monorepo vs. separate repos

**Decision: a lightweight polyglot monorepo.**
- The TypeScript Worker, DuckDB pipelines and Modal Python must agree on the schema and partition layout. A monorepo lets one PR change and test all three together.
- Agents and CI need to see the whole flow: request → sandbox → storage.
- Components can be swapped in and out at the **storage/API boundary** (S3 API, Parquet, DuckLake/Iceberg), not at the git-repo boundary.
- Each part deploys independently through CI path filters (`apps/control-plane/**` → `wrangler deploy`, `services/execution-sandbox/**` → `modal deploy`).

Proposed layout (not all built yet):
- `apps/control-plane`
- optional `apps/query-api` (read-only DuckDB-Wasm)
- `services/execution-sandbox`
- `pipelines/`
- `shared/schemas` and `shared/lakehouse.yaml` (contract definitions)
- `tests/`, `Makefile`, `AGENTS.md`

## What data goes in the lake: the "Personal Analytics Lakehouse"

This is a portfolio project that you also run on your own data.

| Data | Verdict |
|---|---|
| Website and app traffic | Best signal. Safe once anonymised (hash IPs, drop query params). Shows high-frequency partitioned ingestion and rollups. |
| LLM token and cost telemetry | Strong signal. Metadata only, no message bodies. Shows time-series and cost analytics. |
| Raw AI chat histories | Avoid. Unstructured, a high privacy risk, and better suited to a vector DB. |

**Two-bucket pattern:**
- **Demo bucket** (public, open source): seeded NYC taxi data, ephemeral test runs, open read access (CORS) for a DuckDB-Wasm UI. Used by CI and by anyone cloning the repo.
- **Personal bucket** (private): your web traffic, agent cost telemetry and app stats. Pitch: "I run this pipeline every night on my own telemetry for pennies a month."

**LLM telemetry record shape** (numbers and categories compress well in Parquet):

```json
{
  "timestamp": "2026-11-09T18:30:00Z",
  "provider": "anthropic",
  "model": "claude-3-5-sonnet",
  "prompt_tokens": 1420,
  "completion_tokens": 312,
  "cost_usd": 0.00894,
  "latency_ms": 1450,
  "status": "success"
}
```

Example queries: 7-day moving average of spend, P95 latency by model, tokens per second by provider.

**Later (status as of 2026-11-10):**
- There is one bucket, not two.
- The control plane writes JSON telemetry (`telemetry/year=/month=/<taskId>.json`), which compaction skips because it only handles Parquet.
- `AgentTelemetry` doesn't yet have the provider, prompt/completion token split, cost, latency or status fields.
- See ADR 0001, rollout step 5.

# 0003: The lakehouse lives in its own repo

- Status: Accepted
- Date: 2026-11-10

## Context

Gantry started as a monorepo: a lakehouse (R2 + DuckDB + Modal compaction) plus an agent harness that only worked on that lakehouse. The monorepo reasoning (design notes 01) was that the Worker, pipelines and sandbox had to agree on schema and partition layout.

ADR 0001 turned the harness into a factory for any GitHub repo. After that, the only coupling left was one R2 write: the control plane puts a telemetry JSON object under `telemetry/`. The two halves have different languages, deploys, secrets, test strategies (offline Miniflare vs. live R2) and audiences, and CI ran only the lakehouse test.

## Decision

- This repo, **gantry**, is the factory: `apps/control-plane`, `services/execution-sandbox`, and their tests.
- The lakehouse moves to **gantry-lakehouse**: `pipelines/`, `jobs/`, the R2 integration test, and the R2/Modal Makefile targets.
- The coupling is a versioned data contract, `docs/telemetry.md`, owned by the factory.
- gantry-lakehouse is the factory's first target repo (ADR 0001, decision 5), and has a `.gantry.yml`. A factory that opens PRs against a separate repo proves "any repo" better than one working on itself.
- The sandbox image drops `duckdb` and `boto3`. Target repos install what they need through `.gantry.yml` `setup:`.

## Consequences

- Changing the telemetry shape now means a change in both repos. `docs/telemetry.md` says how.
- CI here runs the type-check and the offline control-plane tests. The R2 secrets (`CLOUDFLARE_ACCOUNT_ID`, `R2_*`) are needed only in gantry-lakehouse.
- Unchanged: the Modal app name `gantry-maintenance` and the bucket name `gantry`, so existing deploys keep working.
- History of the lakehouse files before the split stays in this repo's git log.

# Telemetry contract (v1)

The factory's only link to the lakehouse ([gantry-lakehouse](https://github.com/adamlefevre/gantry-lakehouse)) is the telemetry it writes to R2. This file is the contract between the two repos. Change it on purpose: bump the version, and update the lakehouse's readers in the same change window.

## Where

- Bucket: the `GANTRY_BUCKET` R2 binding (`bucket_name` in `apps/control-plane/wrangler.jsonc`, `gantry` by default). The lakehouse's `R2_BUCKET_NAME` must point at the same bucket.
- Key: `telemetry/year=YYYY/month=MM/<taskId>.json`. Year and month are UTC, taken from when the task finished. One object per task, so a re-run of the same task ID overwrites it.
- Object metadata: `taskId`, `status` (the task's final status).
- Written by `TaskCoordinator` in the `finally` of the task run, only when the agent loop returned telemetry. A write failure is logged and doesn't fail the task.

## Record (JSON, `AgentTelemetry` in `apps/control-plane/src/agent.ts`)

| Field | Type | Notes |
|---|---|---|
| `taskId` | string | |
| `model` | string | e.g. `gemini-2.5-flash` |
| `totalTokens` | number | |
| `stepsCount` | number | Agent loop steps used |
| `patch` | string | Final diff from the sandbox |
| `verification` | `"unverified"` \| `"pending"` | See `GLOSSARY.md` |
| `testCommand` | string \| null | `test:` from `.gantry.yml` |
| `completedAt` | string | ISO-8601 UTC |

## Planned

ADR 0001 rollout step 5 moves this to Parquet. That will be v2: a new prefix or format, not an in-place change to v1 files.

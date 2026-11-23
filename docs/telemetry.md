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
| `model` | string | The Claude model ID asked for: `GANTRY_MODEL`, or `model` in `agent-config.json` (`claude-opus-5-5`). Before ADR 0005, records held a Gemini ID such as `gemini-2.5-flash`. |
| `effort` | string | Effort level asked for: `GANTRY_EFFORT`, or `effort` in `agent-config.json`. Added with ADR 0006; older records lack it. |
| `agentConfigVersion` | string | `version` from `apps/control-plane/agent-config.json`. Added with ADR 0006; older records lack it. |
| `agentConfigHash` | string | 16 hex digits identifying the config the run used, after overrides (ADR 0006). Added with ADR 0006; older records lack it. |
| `totalTokens` | number | |
| `stepsCount` | number | Agent loop steps used |
| `commitSha` | string \| null | Commit the sandbox checked out; null with no repo. With `patch`, it says exactly what the diff applies to. Optional: older records lack it. |
| `patch` | string | Final diff from the sandbox (`git add --all --intent-to-add && git diff`), so files the agent created are included |
| `verification` | `"unverified"` \| `"pending"` | See `GLOSSARY.md` |
| `testCommand` | string \| null | `test:` from `.gantry.yml` |
| `completedAt` | string | ISO-8601 UTC |

Fields added to v1 are optional for readers: records written before they existed don't have them. Adding a field is a v1 change; renaming, removing or retyping one needs v2.

## Planned

ADR 0001 rollout step 5 moves this to Parquet. That will be v2: a new prefix or format, not an in-place change to v1 files.

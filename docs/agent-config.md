# Agent config

`apps/control-plane/agent-config.json` is how the agent works: its system prompt, the tools it's offered and how they're described, the model and effort, and its budgets (ADR 0006). `src/agentConfig.ts` validates it at the start of each run.

## Changing it

1. Edit the file and bump `version` (for example `2026-11-22.1` to `2026-11-22.2`).
2. Run `npm test`. A bad key, an unknown tool or a non-positive budget fails the tests, as it would fail a run.
3. Compare runs by `agentConfigVersion` (or `agentConfigHash`) in telemetry.

`GANTRY_MODEL` and `GANTRY_EFFORT` override `model` and `effort` for every run without a code change. The hash includes them; the version doesn't.

## Fields

| Field | Meaning |
|---|---|
| `version` | Your name for this config. Stamped on every run. |
| `model`, `effort` | Claude model ID and effort level (`low`, `medium`, `high`, `xhigh`, `max`). |
| `budgets.maxTurns` | Model turns per task. Setup doesn't count. |
| `budgets.maxTotalTokens` | Stop after the turn that reaches this many tokens, cache reads included. `null` means no cap. The patch so far is kept. |
| `budgets.maxOutputTokensPerTurn` | `max_tokens` on each model call. Keep it at 16,000 or below unless the loop moves to streaming. |
| `budgets.setupTimeoutSeconds`, `budgets.testTimeoutSeconds` | Limits on each `.gantry.yml` setup command and each `runTests` call. |
| `budgets.maxCommandOutputChars` | How much of a command's output (the tail) is kept and shown to the model. |
| `systemPrompt.*` | Sections joined in order: `intro`, `withRepo` (only with a cloned repo), `task`, then `withTests` or `withoutTests`, then `closing`. |
| `tools.<name>` | Offer this tool, with this description. Leave a tool out to stop offering it. |

Placeholders: `{repoUrl}`, `{ref}` and `{testCommand}` in the prompt; `{readLimit}`, `{maxLineLength}` and `{testCommand}` in tool descriptions. Other braces are left as written.

# 0006: Keep the agent's config in a versioned file, and stamp it on every run

- Status: Proposed
- Date: 2026-11-22

## Context

The agent's system prompt, tool descriptions, model, effort and budgets were constants in `agent.ts`. To compare two ways of running the agent (a new prompt, fewer tools, a cheaper model), we need to know which way each recorded run used. A rollback, an A/B test, a replay benchmark, or an agent that proposes a better prompt all start from a config you can diff and a run record that names it.

## Decision

1. **`apps/control-plane/agent-config.json` holds the prompt, tools, model, effort and budgets.**
   - Prompts and tool descriptions are arrays of lines, so a one-line change is a one-line diff. `{repoUrl}`, `{ref}`, `{testCommand}`, `{readLimit}` and `{maxLineLength}` are filled in at run time.
   - `tools` lists the tools offered and the description the model sees for each. A config may offer fewer tools than `agent.ts` knows, never others. `runTests` is still offered only when the repo declares a test command.
   - Budgets: `maxTurns`, `maxTotalTokens` (null for no cap), `maxOutputTokensPerTurn`, the setup and test timeouts, and how much command output is kept.
   - `src/agentConfig.ts` validates it with zod at the start of every run. Unknown keys and tools are rejected, so a typo fails loudly before a sandbox starts.
   - Tool input schemas and tool code stay in `agent.ts`, since changing them is a code change.
2. **Every run records which config it used.**
   - `version` in the file is bumped by hand on each change worth comparing.
   - `agentConfigHash` is the first 16 hex digits of the SHA-256 of the config the run actually used, keys sorted, after the `GANTRY_MODEL` and `GANTRY_EFFORT` overrides. It catches an edit that forgot to bump `version`, and tells apart runs whose overrides differed.
   - Both go in the telemetry record (with `effort`) and on the task row (`agent_config_version`, `agent_config_hash`).
3. **`runAgentLoop` takes an optional `agentConfig`** in the same shape, for tests and for replaying tasks against a candidate config without deploying it.

The sandbox image stays in `services/execution-sandbox/service.py` for now: the Worker can't choose an image until the sandbox contract takes one.

## Consequences

- Changing how the agent works is a PR to one file, and its effect shows up in telemetry by version.
- `GANTRY_MODEL` and `GANTRY_EFFORT` still work as overrides; they change the hash but not the version.
- Telemetry v1 gains three fields. Older records don't have them, so readers treat them as optional.

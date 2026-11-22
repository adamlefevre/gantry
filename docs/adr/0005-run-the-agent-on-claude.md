# 0005: Run the agent on Claude, through the Anthropic SDK

- Status: Proposed
- Date: 2026-11-22
- Amends: ADR 0001, decision 1 (the loop is still ours; it no longer sits on the Vercel AI SDK)

## Context

The agent loop ran Gemini (`gemini-2.5-flash`) through the Vercel AI SDK v4 and `@ai-sdk/google`. For the first live run we want the agent on Claude, with an Anthropic API key in place of the Gemini key.

Claude Opus 5.5 is stricter about request shape than the models the AI SDK v4 provider was written for:
- thinking is always on, and each assistant turn, thinking blocks included, has to go back to the API unchanged;
- forced `tool_choice` and sampling parameters such as `temperature` return a 400;
- effort (`output_config.effort`) and server-side refusal fallbacks are new request fields.

## Decision

1. **The loop calls Claude through the official `@anthropic-ai/sdk`, on a loop we write ourselves.**
   - `agent.ts` sends one `client.beta.messages.create` per model turn, runs every tool call in that turn, and sends all the results back in one user message. It appends each assistant turn exactly as the API returned it.
   - The loop is still ours, as ADR 0001 decision 1 and ADR 0004 want: it records every step and token, keeps the model key in the Worker, and is tested offline against a scripted mock of the Messages API (`tests/mock-anthropic-server.ts`).
   - One model call plus its tool results is already the unit of replay that the step-4 checkpoint plan needs (design note 04), so that plan no longer needs `generateText({maxSteps: 1})`.
   - Tool calls in a turn run one after another, so two edits to the same file can't race. Design note 04's per-path mutation queue isn't needed.
   - Rejected: keeping the AI SDK and swapping in `@ai-sdk/anthropic`. The v4 provider predates these request rules, and a provider layer between us and the API is one more place for them to drift.
2. **Defaults.**
   - Model `claude-opus-5-5` (`DEFAULT_MODEL`). `GANTRY_MODEL` picks another current Claude model (Claude 4.6 or later, since the loop sends adaptive thinking and effort).
   - Effort `high` (`DEFAULT_EFFORT`), since Opus 5.5 defaults to `medium`. `GANTRY_EFFORT` overrides it, for example `medium` to cut cost.
   - Adaptive thinking, top-level prompt caching (each turn re-reads the conversation from cache), and `max_tokens` 16,000, which stays under the SDK's non-streaming timeout.
   - Server-side refusal fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`) for the models that take them. A refusal that the whole chain declines fails the task.
3. **The key is `ANTHROPIC_API_KEY`,** a Worker secret like `AGENT_SANDBOX_TOKEN`. It never reaches the sandbox. `ANTHROPIC_BASE_URL` exists only so the tests can point at the mock.

## Consequences

- `GOOGLE_GENERATIVE_AI_API_KEY` and `GOOGLE_GENERATIVE_AI_BASE_URL` are gone. A deployed Worker needs `ANTHROPIC_API_KEY` set before its next task runs.
- `ai` and `@ai-sdk/google` are no longer dependencies.
- Telemetry stays v1: `model` holds the Claude model ID that was asked for. When a fallback model answers a turn, the record still names the requested model.
- If this ADR is accepted, ADR 0001 decision 1 gets a note: "Amended by ADR 0005: the loop calls Claude through the Anthropic SDK."

# 0001: Gantry is a software factory for any GitHub repo

- Status: Accepted
- Date: 2026-11-10

## Context

The first version of the agent harness only worked on gantry itself:
- The sandbox image was gantry's Python stack, with no git and no code cloned.
- The system prompt hardcoded Python and pytest.
- A task was a free-text prompt.
- The result was a diff saved to R2.

The goal is a factory: label an issue in any repo and get back a verified PR.

## Decisions

1. **The agent loop is our own, built on the Vercel AI SDK.**
   - `agent.ts` drives the loop with `generateText` and tool calls (`runCommand`, `writeFile`, `readFile`, `getDiff`) against the Modal sandbox API. The sandbox stays a dumb execution layer.
   - We build the loop ourselves on purpose: it is the part of the project we want to show, and owning it lets the factory record every step, token and cost as telemetry.
   - The model provider sits behind the AI SDK, so it can be swapped (Gemini today).
   - Model API keys stay in the Worker. The sandbox never sees them.
   - Rejected: running an existing headless coding agent CLI inside the sandbox. It would be stronger out of the box, but it hides the loop, puts the model key inside the sandbox, and makes telemetry depend on someone else's output format.

2. **Per-repo environment.**
   - Default: a generic image (git, Python, Node, uv) plus `.gantry.yml` at the repo root, with `setup:` and `test:` commands and an optional `image:`.
   - Fallback: the repo's `devcontainer.json` or `Dockerfile`, with images cached by repo + lockfile hash.
   - The repo's own `AGENTS.md`/`CLAUDE.md` give the agent its instructions.

3. **Repo access goes through a GitHub App.**
   - A webhook on the `ready-for-agent` label triggers a task.
   - The sandbox runs untrusted code, so it gets only a short-lived **read-only** token for cloning.
   - The control plane creates the branch, commit and PR from the final diff through the GitHub API.

4. **The factory enforces red-green verification.** The agent doesn't grade itself.
   - **Red:** the agent writes a test that reproduces the issue. The factory runs it against the original code, and it must fail.
   - **Green:** after the fix, that same test (as captured at the red step) must pass, and so must the repo's full test suite.
   - **No applicable test** (docs, config, no test infrastructure): open a draft PR labeled unverified, or relabel the issue `ready-for-human`.
   - **No `test:` in `.gantry.yml`:** the repo only ever gets draft PRs.

5. **The lakehouse becomes the factory's analytics store.**
   - Task telemetry is written to R2 as Parquet, compacted by the existing pipeline, and queried with DuckDB.
   - Gantry is the first repo the factory works on. (Superseded by ADR 0003: the lakehouse moved to gantry-lakehouse, which is now the first target repo.)

## Consequences

- `agent.ts` stays the agent. The new work goes into the sandbox service (clone, setup, verification commands), a verification step the factory runs around the loop, and a GitHub integration in the control plane.
- The sandbox wire contract grows: `/session/create` takes `repo_url` and `ref`, and commands run inside the checkout.
- Agent quality depends on our prompts, tools and step limit (`maxSteps`), so improving them is ongoing work.

## Rollout

1. The sandbox clones `{repo_url, ref}`, with git installed.
2. A task becomes `{repo, issue}`; add `.gantry.yml`. (Done; ADR 0002 records where `.gantry.yml` is parsed.)
3. Add the GitHub App, the label webhook and opening PRs from the control plane.
4. Add factory-run red-green verification around the agent loop, and raise the loop's step limit and tools as needed.
5. Write telemetry as Parquet, plus an analytics view.

# 04: Rollout step 4 plan: factory stages, red-green, and harness transplants

- Date: 2026-11-10
- Status: plan. It builds on ADR 0004 (Proposed) and ADR 0001 decision 4.
- Inputs:
  - Vercel's post on building a software factory for the AI SDK (its stages, evidence, run outcomes, and an eval case per failure);
  - eve's harness at `1.0.0-rc.9`, for `edit_file`, `read_file` paging, the read-before-write guard and crash recovery (design note 03).

## Goal

Turn today's single agent loop into a factory pipeline that the `TaskCoordinator` DO runs:

- **The factory, not the agent, decides** whether a change works (red-green).
- **Each stage has its own prompt, tools and step budget**, and starts from a fresh context.
- **A redeploy or eviction mid-task resumes the task** instead of losing it.
- **Every run ends in an explicit outcome** that says what happens next.

Step 3 (the GitHub App and opening PRs) isn't built yet. This step records the outcome and the verified patch. Step 3 then turns the outcome into a PR, a draft PR or a relabel.

## The pipeline

The DO runs these stages in order. Each agent stage is one call through the `AgentRunner` seam (ADR 0004).

| Stage | Run by | Tools | Step budget | Ends with | Gate |
|---|---|---|---|---|---|
| setup | factory | — | — | — | Every `setup:` command exits 0 (exists today) |
| red | agent | `readFile`, `editFile`, `writeFile`, `grep`, `runCommand` | 12 | `submitRedTest {testFiles, testCommand, rationale}` or `noTestApplicable {reason}` | The red diff touches only `testFiles` |
| red check | factory | — | — | — | `testCommand` exits non-zero on the original code |
| implement | agent | the red tools plus `runTests` | 24 | `submitFix {summary}` | — |
| green | factory | — | — | — | The red test files are restored from the snapshot, then `testCommand` exits 0, then the full `test:` exits 0 |
| review | agent (no sandbox tools) | — | 1 | `verdict {approve \| request_changes \| reject, notes, risk}` | — |

- A failed green or a `request_changes` sends the run back to **implement**, with the failure output or the reviewer's notes. That happens at most **2 times**, as in the article and Foreman.
- The reviewer sees only the issue, the final diff (`git add -N . && git diff`, so new files show up), and the red and green outputs. It advises and can't override green. A `reject` makes the outcome `flawed`.
- Budgets are constants in one place, so telemetry can tune them later.
- The structured `submit*` and `verdict` tools have no `execute`. Calling one ends the stage, and the DO reads its arguments as the stage result.

### Red-green mechanics

1. **Scope check.** After red, `git status --porcelain` may list only paths in `testFiles`. If the agent touched anything else, red is retried once with that feedback, and the outcome is `flawed` after that.
2. **Snapshot.** The DO reads each test file through `/file/read` and stores it in a `red_snapshot` table. This is the test "as captured at the red step" (ADR 0001).
3. **Red check.** The DO runs `testCommand` right away. Red has added only tests, so this runs against the original code. Exit 0 means the test doesn't reproduce the issue, so the outcome is `flawed` and the reason is recorded.
4. **Restore before green.** The DO writes the snapshot back over whatever implement left. If implement had edited a red test file, the DO records `redTestModified: true` and the reviewer sees it.
5. **Green.** `testCommand` must exit 0, then the full `test:` must exit 0.

Known weak spot: `testCommand` comes from the agent, so a gamed red test (one that fails for a reason unrelated to the issue) can get past the red check. Green catches commands that never pass. The reviewer is told to judge whether the red test reproduces the issue. Any non-zero exit counts as a red failure (decision 2), so a collection error passes the red check too. The reviewer is the check on that.

### Run outcomes

There are two fields. `verification` says what the factory proved. `outcome` says what happens next. These are the article's four outcomes.

| outcome | When | Next (step 3) |
|---|---|---|
| `success` | Red failed, green passed, the reviewer approved | Ready PR |
| `flawed` | Red didn't fail, red went out of scope, green failed after 2 revisions, or the reviewer rejected | No PR. Comment and relabel `ready-for-human`. Add an eval case. |
| `blocked` | Infrastructure: setup failed, the sandbox is gone, too many resumes, a model API error | Task `FAILED` with the reason. Fix the environment. |
| `manual` | `noTestApplicable`, or no `test:` in `.gantry.yml` | Draft PR labeled unverified (ADR 0001 decision 4) |

`verification` grows from `unverified | pending` to `unverified | red-green-passed | red-green-failed | no-red`. `pending` is only the in-flight value. `GLOSSARY.md` gets **Stage**, **Run outcome**, **Red test** and **Red snapshot**.

## Transplant 1: file tools from eve

eve's `tools/provided/edit-file.ts` is itself a port of pi's `edit` tool (`badlogic/pi-mono`, MIT). eve's `NOTICE` already credits it. We port from eve (Apache-2.0) and keep both attributions in a `NOTICE` file and in the file headers.

**What we port into `src/tools/` as pure functions with unit tests.** eve's `edit-file.test.ts` has 22 cases to port.
- **`editFile {path, edits: [{oldText, newText}]}`**: every edit is matched against the original file.
  - The edit fails if any `oldText` is missing, appears more than once, overlaps another, or produces no change. The error messages tell the model how to fix the call.
  - It falls back to a fuzzy match that ignores smart quotes, Unicode dashes and spaces, and trailing whitespace. It then rewrites only the lines it touched, so other lines keep their bytes.
  - It keeps the file's BOM and CRLF line endings.
  - It repairs common malformed inputs: `edits` sent as a JSON string or a single object, or a top-level `oldText`/`newText` pair.
- **The read-before-write guard on `writeFile`**: overwriting an existing file requires a prior `readFile` of the same content (a SHA-256 stamp from `crypto.subtle`). Otherwise the call fails with "read it first". The stamps live in memory per stage, so after a resume the model just re-reads.
- **`readFile` paging**: `offset` and `limit` in lines (default 2,000), with lines over 2,000 characters cut, and `totalLines` plus `truncated` in the result. Today a single read can put up to 1 MiB into the context. This is the biggest token saving in the plan.
- **A per-path mutation queue**: the AI SDK runs a step's tool calls in parallel, so two edits to one file must be serialized.

**What we drop:**
- `$HOME`, `~` and `file://` path resolution. Paths are relative to `/workspace`, and absolute paths outside it are rejected.
- Mode restoration: `/file/write` opens the existing file with `open(p, 'w')`, which keeps its mode. A test should confirm this.

**Sandbox hardening (`service.py` and the mock, together):**
- `/file/write`: `open(p, 'w', encoding='utf-8', newline='')`, so the locale or newline translation can't change bytes.
- `editFile` refuses a file that `/file/read` reports as `truncated`. It also refuses one whose content holds U+FFFD, the stand-in for non-UTF-8 bytes. Still to check: what Modal's text-mode `exec` returns for invalid UTF-8.
- `grep` runs `rg` or `grep -rn` through `/exec`, with arguments quoted the way `edit-file.ts`'s `quoteShell` does. That's fine, because `/exec` is already the agent's shell.

## Transplant 2: checkpoints and recovery

This follows eve's model (`harness/interrupted-attempt.ts`, 65 lines): checkpoint at step boundaries, and after a crash tell the model which calls may have run rather than silently repeating them.

**The loop changes shape.** Today's single `generateText({maxSteps: 16})` becomes an outer loop that the DO owns:

```ts
while (step < budget) {
  const res = await generateText({ model, system, messages, tools, maxSteps: 1 });
  // In one SQLite transaction: append res.response.messages, add the usage, step++
  if (endsStage(res)) break;           // a submit*/verdict call, or no tool calls
}
```

AI SDK v4's `response.messages` includes the tool results. So one model call plus its tool executions is the unit of replay, exactly like an eve step.

**Storage (DO SQLite, in `initDatabase`):**
- `transcript(task_id, stage, attempt, idx, message_json)` is append-only, with **one row per message**. DO SQLite caps a row at 2 MB, and a whole transcript could pass that once file reads are in it. Paged `readFile` keeps each message well below the cap.
- `stages(task_id, stage, attempt, status, result_json, usage_json, started_at, finished_at)`.
- `steps` (exists) gains `stage`, `call_id` and `status` (`started`, `completed`, `failed`). A row is written **before** a tool runs and updated after. That's what makes "this call may or may not have taken effect" knowable.
- `tasks` gains `sandbox_id`, `outcome` and `resume_count`.
- `red_snapshot(task_id, path, content)`.

**Resume:**
- The DO arms an alarm at task start and re-arms it on every step, about 90 s ahead.
- `alarm()`: if the task is `RUNNING` and no loop runs in this instance (an in-memory flag, which a restart clears), it reloads the current stage's transcript. It turns `steps` rows with `status = started` past the last checkpoint into eve's note: *"An infrastructure failure interrupted your previous attempt… check whether it already took effect."* Then the loop continues.
- Factory stages (red check, green) are just re-run, since they're cheap and mostly idempotent.
- After 3 resumes, or when the sandbox is gone (an `/exec` error naming a missing sandbox), the outcome is `blocked`.

**The sandbox moves to the DO.** Today `runAgentLoop` creates the sandbox and terminates it in its `finally`. Red, green and review need one sandbox across stages and across resumes. So `src/sandbox.ts` (a client for `/session/create`, `/exec`, `/file/*` and `/session/terminate`) is owned by the DO. It's created once, stored on the `tasks` row, and terminated when the outcome is final. The 30-minute sandbox lifetime becomes the task's hard limit. That's fine for now, and the budgets above are sized to it.

## The seam

```ts
interface AgentRunner {
  run(stage: StageSpec, ctx: { sandbox: SandboxClient; store: StageStore; onStep; onChunk }): Promise<StageResult>;
}
// StageSpec: { name, system, input, tools, budget, endTools }
// StageResult: { ended: { tool, args } | null, steps, usage, messages }
```

- `agent.ts` becomes the AI SDK implementation: the outer loop, checkpoints and the interrupted note.
- `pipeline.ts`, new, holds the stage order, red-green, the outcomes and the retry policy. The DO calls it.
- The tests drive `AgentRunner` through the scripted mock Gemini server (`tests/mock-gemini-server.ts`, pointed at by `GOOGLE_GENERATIVE_AI_BASE_URL`), exactly as they drive `generateText` today.

## Telemetry

`AgentTelemetry` gains `outcome`, the wider `verification`, and `stages: [{stage, attempt, steps, totalTokens, result}]`, plus `redTestModified` and `resumeCount`. These fields ship with v2, the Parquet move (decision 1). Until then the v1 record doesn't change. It's still one object per task, written only by the DO, under `telemetry/`.

`stepsCount` today counts tool calls, setup included, although the `MAX_AGENT_STEPS` comment says model round trips. Each stage should record both counts, with clear names.

## Tests (all offline, Miniflare plus the mocks)

- Unit: the `editFile` matching cases (ported), the read-before-write guard, `readFile` paging, and the interrupted-note wording.
- Pipeline, with scripted mock models:
  - the happy path ends `success`;
  - a red test that passes on the original code ends `flawed`;
  - a red stage that edits source ends `flawed` after one retry;
  - green fails twice and ends `flawed`;
  - implement edits the red test: the snapshot is restored and `redTestModified` is set;
  - a reviewer `request_changes` causes a revision, and the run then ends `success`;
  - `noTestApplicable` ends `manual`;
  - no `test:` ends `manual` and `unverified`;
  - a setup failure ends `blocked`.
- Recovery:
  - kill the loop after a tool's `started` row and before the checkpoint. The alarm resumes it, the next model input contains the interrupted note, and the call isn't repeated automatically;
  - 3 resumes end `blocked`.
- `mock-modal-server.ts` gains fixture repos, so `/exec` can return test pass or fail depending on which files were written, and a "sandbox gone" mode.

Real-model evals (Gemini against fixture issues in gantry-lakehouse) are a separate opt-in `make eval`. They are never part of CI, per AGENTS.md. Each `flawed` run found in production becomes a fixture there, as in the article.

## Work breakdown (each slice is one PR that stays green)

1. **The sandbox client moves to the DO.** Add `src/sandbox.ts`, plus `sandbox_id` on `tasks`. Behavior doesn't change.
2. **The file tools.** `editFile`, `readFile` paging, the write guard and the mutation queue, plus the `service.py` hardening and the mock changes. They plug into today's single loop, so they pay off immediately.
3. **The outer loop and checkpoints.** Add `AgentRunner`, the `transcript` and `stages` tables, and the started/completed rows on `steps`. There's still one stage.
4. **Resume.** Add the alarm, the interrupted note and `resume_count`.
5. **The pipeline.** Add `pipeline.ts` with the stages, the structured end tools, red-green with the snapshot, and the outcomes.
6. **The reviewer stage** and the revision loop.
7. **Docs.** `GLOSSARY.md`, an ADR 0001 rollout note, and ADR 0004 accepted. The telemetry fields wait for v2 (decision 1).

Slices 1 to 4 are worth doing even if the pipeline changes later. Slice 2 is the one to start with.

## Decisions (2026-11-10)

1. **Telemetry:** the new fields wait for v2, together with the Parquet move. Until then, `AgentTelemetry` keeps its v1 shape, and stage-level data lives only in DO SQLite.
2. **Red failure:** any non-zero exit from `testCommand` counts. There are no per-runner exit codes. The reviewer judges whether the red test fails for the right reason.
3. **A rejected review after a passed green:** the outcome is `flawed`, and no PR is opened.
4. **The AI SDK:** stays on v4 for this step. The outer loop uses `maxSteps: 1`.

## Not in this step

- Compaction (transplant 3): wait until telemetry shows stages near their budget.
- Factory notes per repo (ADR 0004, consequences).
- Backports, docs agents, and a separate classifier or analyst. The red stage does the analyst's "failing probe" job.

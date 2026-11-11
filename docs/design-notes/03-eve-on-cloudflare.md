# 03: Could Gantry run on eve and still keep Cloudflare?

- Date: 2026-11-10
- Status: research and options. The decision is ADR 0004.
- Sources: [vercel/eve](https://github.com/vercel/eve) at `1.0.0-rc.9` (Apache-2.0); [vercel-labs/eve-software-factory-template](https://github.com/vercel-labs/eve-software-factory-template) ("Foreman", MIT); the Workflow SDK docs (workflow-sdk.dev); the Cloudflare Containers docs.

## Why this note exists

Vercel's post on building a software factory for the AI SDK describes the same issue-to-PR factory as Gantry, with the same security stance. The post doesn't say Vercel's internal `ai-sdk-factory` runs on eve. Only the deploy-your-own template, Foreman, is "built on eve". This note asks whether Gantry could use eve while keeping its Cloudflare control plane (a Worker, one Durable Object per task) and its Modal sandbox. ADR 0001 decision 1 ("the agent loop is our own") is the baseline to compare against.

## What eve is, briefly

- A filesystem-first agent framework built on the AI SDK. It discovers tools, subagents, channels and instrumentation from `agent/`.
- It runs each **session** as a durable Workflow SDK workflow. A turn checkpoints at each **step** (one model call plus its tool calls). The "world" stores the event log and queues the work that resumes it.
- The loop, model calls and secrets run in the app runtime. The sandbox has no environment variables or secrets. The file and bash tools reach it through the app. This matches Gantry's rule that model keys stay in the Worker.
- Deployment targets: Vercel (`.vercel/output`) or a self-hosted Nitro **Node** server (`.output/`).

## Answers to the open questions

### 1. Can an eve build run on Cloudflare Workers? No.

- `eve build` doesn't let you choose a Nitro preset. The type is `preset: "vercel" | undefined` (`packages/eve/src/internal/nitro/host/host-spec.ts`). `build-application.ts` sets it to `"vercel"` or leaves it unset, and the post-build steps assume `node-server`. Nitro's Cloudflare preset appears only in a research note about how eve wraps the server entry.
- The runtime reads build artifacts from disk at request time with `node:fs/promises`: model metadata, the sandbox's prepared-artifact manifest, and workspace seed files (`runtime/loaders/model-metadata.ts`, `runtime/sandbox/prepared-artifacts.ts`, `runtime/workspace/seed-files.ts`). A Worker has no such filesystem.
- The source imports `node:child_process` (52 files), `node:http`, `node:net`, `node:worker_threads` and `node:vm`. Most of that is the CLI and the local sandbox bindings, but none of it is separated into a Workers-safe runtime package.
- Workflow worlds expect a long-lived process (see 2).
- None of eve's deployment docs mention Workers. Forcing a Cloudflare preset would mean maintaining a fork of a pre-1.0 framework.

### 2. Could a Durable Object back a Workflow world? In principle, but it doesn't help.

- The world interface is public: Storage (`runs`, `steps`, `events`, `hooks`), Queue (`queue`, `createQueueHandler`, `getDeploymentId`) and Streamer (`streams.*`). A package that exports `createWorld()` can be selected with `experimental.workflow.world`.
- eve asks for more than the base interface: spec version 9, atomic start hooks, and `hookForceClaim` plus `hookRetention` for handoffs. The world must also be built against the same `@workflow/*` major version as eve (5.x today).
- The world runs **inside the eve process**: `start()` begins queue polling and deliveries POST back to `/.well-known/workflow/v1/flow`. eve would still need Node. The DO would only be a remote database for it, reached over HTTP on every checkpoint.
- Gantry's tasks are short (a sandbox lives at most 30 minutes). Durability measured in days, approvals and parked turns is eve's main selling point, and Gantry doesn't need it. If a task's process dies, the DO can fail or rerun the task.
- Verdict: a DO-backed world is a large custom project to win durability Gantry doesn't use. Reject it.

### 3. Is a hybrid sensible? It works, but it costs a second runtime.

The shape:

```text
Worker (router)
  └─ TaskCoordinator DO   owns task state, SQLite, WebSockets, R2 telemetry, red-green, GitHub
       ├─ eve Node service   the loop: model calls, tools, stations as subagents
       │     └─ ModalSandbox provider (defineSandboxProvider) ─┐
       └─ Modal sandbox API  (factory-run setup and verification) ◄┘ same sandbox
```

- **Where the eve service runs:**
  - **Cloudflare Containers**: addressed through a Durable Object (`getByName(id)`), so it can be one container per task. With one eve process per task, the local world on the container's disk is enough, since a lost task gets rerun. It keeps everything on Cloudflare. Not yet verified: GA status, cold start, pricing, disk persistence, and whether `wrangler dev` runs it offline.
  - **Modal**, as a Node web server next to the sandbox service: one fewer vendor, but the loop would move off Cloudflare, which is the thing this exercise wants to keep.
  - **Any Node host with the Postgres world**: needs a database and runs replicas behind a load balancer. That's too much infrastructure for one owner.
- **Latency:** each model step already costs seconds. One extra hop (DO to eve) per task, plus a hop per checkpoint if the world is remote, is small next to that. The real cost is the container cold start per task.
- **Cost:** container time for the whole run, on top of the DO and Modal.
- **Tests:** Miniflare can't run eve. The control-plane suite would test the DO against a **mock eve server**, the way it tests against `mock-modal-server.ts` today. The agent would get a second, Node-only suite (see 6). Today, one offline suite covers the whole loop.
- **Sandbox contract growth:** eve's `SandboxConnection` wants more than Gantry's request/response API offers:
  - `spawn` with streamed stdout and stderr, optional stdin, and `kill()`. A buffered `/exec` response can be wrapped into streams, but kill and abort need a new endpoint.
  - `removePath`, which needs a new `/file/remove` endpoint.
  - `writeFiles` (batched), which can loop over `/file/write`.
  - `start()` must return the same sandbox for a given session ID. The DO creates the sandbox and runs `setup:`, so it has to pass that sandbox ID to eve (in session metadata) for `start()` and `resume()` to attach to. `onSessionEnd` must **not** terminate it, because the DO still has to run green verification.
  - Per AGENTS.md, `service.py`, the provider and `mock-modal-server.ts` change together.

### 4. Telemetry: it maps well.

- An `agent/instrumentation/*.ts` file with `defineInstrumentation` receives lifecycle events. `model.call.settled` carries usage, and `call.settled` gives one event per tool call. The session stream also has `usage.recorded`. `totalTokens` and `stepsCount` in `AgentTelemetry` can be derived from these.
- The eve service should **return** these numbers to the DO, not write to R2. R2 writes stay in the DO through the `GANTRY_BUCKET` binding, under `telemetry/` (AGENTS.md). `docs/telemetry.md` v1 doesn't change.
- Agent Runs export is on by default only for Vercel preview and production deployments. Default-export `disableInstrumentation()` from `agent/instrumentation/agent-runs.ts` to make that explicit. Self-hosted builds export OTel only to destinations you configure.
- eve's CLI collects usage data separately. Set `EVE_TELEMETRY_DISABLED=1` in CI and build scripts.

### 5. Red-green belongs in the DO, around agent sessions, whichever loop we use.

ADR 0001 decision 4 says the factory, not the agent, decides. In every option, the DO runs these stages:

1. setup (exists today)
2. **red:** an agent session writes a reproducing test. The DO snapshots that test and runs it against the original code through `/exec`. It must fail.
3. **implement:** an agent session writes the fix.
4. **green:** the DO runs the snapshotted test and the full `test:` command. Both must pass.
5. **review (borrowed from Foreman):** an agent that sees only the diff and the issue gives a verdict. It can send work back to step 3 at most twice. It advises; it doesn't replace green.

Foreman's Implementer runs the checks itself, and its Reviewer is another model. That is the agent grading itself, which ADR 0001 rejects. So with eve, Gantry would use eve for the loop inside steps 2, 3 and 5, and keep the pipeline in the DO.

### 6. Offline tests with eve: feasible, in a separate suite.

- `mockModel` from `eve/evals` gives fixed or scripted replies with estimated token usage, so no provider is called.
- Tool stubs (`t.session({ stubs })`) return fixed tool results, but the target must explicitly permit tool replacement.
- A `ModalSandbox` provider pointed at `mock-modal-server.ts` keeps the sandbox offline.
- Not yet verified: whether the eval runner and a local `eve` server run with no network at all. eve's own CLI telemetry and model-metadata lookups need checking with `EVE_TELEMETRY_DISABLED=1` and the network off.

### 7. What happens to ADR 0001 decision 1?

Amend it; don't supersede it. The part worth owning is the **factory**: task state, stages, verification, GitHub, and telemetry. ADR 0004 records that the loop sits behind a seam, and that eve is a possible future implementation of that seam, not today's.

## Options

| | A. Own loop + Foreman ideas (baseline) | B. eve on Workers | C. Hybrid: DO + eve Node service | D. eve + DO-backed world |
|---|---|---|---|---|
| Feasible | Yes | No (no preset, runtime needs fs and Node) | Yes | Only with eve still on Node (C plus a custom world) |
| Runtimes | Worker + Modal | — | Worker + container + Modal | Same as C |
| Offline tests | One Miniflare suite, as today | — | Miniflare + mock eve, plus a Node eve suite | Same as C, plus world tests |
| Sandbox contract | Unchanged | — | Grows: kill/abort, remove, a shared-sandbox handoff | Same as C |
| Telemetry | Native, every step | — | Through instrumentation, returned to the DO | Same as C |
| Version risk | AI SDK only | — | eve is `1.0.0-rc.9`; self-hosted worlds strand sessions on any eve version change | Same, plus Workflow 5.x coupling |
| What we get | Full control; the loop is the showcase (ADR 0001) | — | Compaction, subagents, skills, evals, built-in edit/grep tools | Nothing beyond C for short tasks |

## Recommendation

**A now, with a seam that keeps C open.**

1. Keep `agent.ts` as the loop. Give it an `AgentRunner` interface, `run(stage, input) → {patch?, verdict?, steps, usage}`, that the DO calls once per stage. That interface is where an eve-backed runner would plug in.
2. Build ADR 0001 rollout step 4 as DO-run stages (red, implement, green, review), as in answer 5.
3. Borrow from Foreman:
   - separate stage prompts and tool sets (an analyst that reads only, an implementer, a reviewer that sees only the diff);
   - a "factory brain" of per-repo notes. It needs a home: DO SQLite keyed by repo, or a new R2 prefix. A new R2 prefix would mean amending the AGENTS.md rule that R2 writes go only under `telemetry/`;
   - an eval suite that runs offline against the mock model and the mock sandbox.
4. Revisit C if one of these happens: our loop needs compaction or subagents that are costly to build; eve reaches 1.0 with a documented non-Vercel durable world; Cloudflare Containers is GA with acceptable cold starts; or the tasks grow long enough (hours, human approvals) that durability starts to matter.

## If we did C: a spike plan (not now)

1. Spike: an `eve build` of a toy agent with `mockModel` and a `ModalSandbox` provider against `mock-modal-server.ts`, run with the network off. This answers the open part of question 6.
2. Spike: the same build in a Cloudflare Container behind a DO via `wrangler dev`. Measure cold start, image size and memory.
3. Grow the sandbox contract (kill/abort, `/file/remove`) in `service.py`, the provider and the mock, together.
4. Write an `EveRunner` behind the `AgentRunner` seam, and a mock eve server for the Miniflare suite.
5. Run both runners against gantry-lakehouse issues and compare pass rate, tokens and wall time from telemetry.

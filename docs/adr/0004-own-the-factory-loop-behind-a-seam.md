# 0004: Own the factory; keep the agent loop behind a seam (eve not adopted yet)

- Status: Proposed
- Date: 2026-11-10
- Amends: ADR 0001, decision 1

## Context

Vercel's eve framework and its software-factory template, Foreman, solve the same problem as Gantry: an issue goes in, a PR comes out. We looked at whether Gantry could run its agent on eve while keeping the Cloudflare control plane (a Worker, one Durable Object per task) and the Modal sandbox. The findings are in `docs/design-notes/03-eve-on-cloudflare.md`. In short:

- eve can't run on Workers. `eve build` targets only Vercel or a Nitro Node server, and its runtime reads build artifacts from disk.
- A Durable Object could back a Workflow world, but eve itself would still need a Node process, and Gantry's short tasks don't need eve's multi-day durability.
- A hybrid works: the DO stays the owner and calls an eve Node service, for example on Cloudflare Containers, which drives the Modal sandbox through a custom sandbox provider. It adds a second runtime and a second test suite, grows the sandbox contract, and ties us to a pre-1.0 framework whose self-hosted sessions can't survive an eve version change.
- Foreman's verification is the implementer running the checks, plus a reviewer agent. ADR 0001 decision 4 requires the factory to verify, so that part would stay ours in any case.

## Decision

1. **The factory is ours.** Task state, the stage pipeline (setup, red, implement, green, review), verification, GitHub writes and telemetry live in the `TaskCoordinator` DO. No agent framework owns them.
2. **The loop sits behind a seam.** The DO calls an `AgentRunner` once per stage. Today's runner is our own AI SDK loop (`agent.ts`), as ADR 0001 decision 1 says. Any other runner must:
   - keep model keys out of the sandbox;
   - return usage and step counts to the DO, which alone writes R2 telemetry (`docs/telemetry.md`);
   - be testable offline.
3. **We borrow Foreman's ideas, not its runtime:**
   - per-stage prompts and tool sets;
   - a reviewer that sees only the diff and the issue, and advises without replacing green verification;
   - per-repo factory notes;
   - an offline eval suite.

   We also port specific harness pieces from eve's source (Apache-2.0, with attribution) into our own loop: `edit_file` matching, `read_file` paging, the read-before-write guard, and checkpoint-and-recovery semantics built on DO SQLite and alarms. Compaction follows later, if telemetry shows we need it. `docs/design-notes/04-rollout-step-4-plan.md` has the plan.
4. **eve is not adopted now.** We revisit it, as an eve-backed runner hosted in a Cloudflare Container, if one of these happens:
   - our loop needs compaction or subagents that are costly to build;
   - eve reaches 1.0 with a documented non-Vercel durable world;
   - Cloudflare Containers is GA with acceptable cold starts;
   - tasks grow long enough to need durability.

## Consequences

- Rollout step 4 is built as DO-run stages around the runner. The sandbox contract doesn't change for this ADR.
- The factory notes need a home. Storing them in R2 would mean amending the AGENTS.md rule that R2 writes go only under `telemetry/`. DO SQLite avoids that.
- An eve runner later would need sandbox endpoints for kill/abort and file removal. It would also need a way to attach to the sandbox the DO already created and set up. The design note has the spike plan.
- If this ADR is accepted, ADR 0001 decision 1 gets a note: "Amended by ADR 0004: the loop sits behind the `AgentRunner` seam."

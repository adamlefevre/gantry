# 0002: Parse `.gantry.yml` in the Worker, not the sandbox service

- Status: Accepted
- Date: 2026-11-10

## Context

ADR 0001 (decision 2) adds `.gantry.yml` at the target repo root: `setup:` and `test:` commands, plus an optional `image:`. The file comes from the target repo, so it is untrusted. Something has to read it after checkout and turn it into setup commands, a test command, and whether the run can be verified.

Two places could parse it:
- **The sandbox service** parses it at `/session/create` and returns it in the response.
- **The control plane (Worker)** reads it through the existing `/file/read` endpoint and parses it itself.

## Decision

The Worker parses it (`apps/control-plane/src/gantryConfig.ts`), using the `yaml` package (pure JS, runs on Workers) and a zod schema.

- The service stays a dumb execution layer, as ADR 0001 decision 1 says. Its wire contract doesn't change shape.
- The policy that depends on the config (verification status, the system prompt, the `runTests` tool, and later draft-vs-ready PRs) lives in the control plane, so the parsing does too.
- The offline Miniflare suite covers it. `service.py` has no tests and hasn't run on Modal yet.
- A missing file is a 404 from `/file/read`. An empty file means no config. Invalid YAML or a wrong-typed field fails the task with a clear error rather than silently running unverified.

### Untrusted-input limits

- The file is capped at 64 KiB in the Worker. `/file/read` is capped at 1 MiB in the service, so a symlink to `/dev/zero` can't exhaust memory.
- YAML aliases are disallowed (`maxAliasCount: 0`) to rule out expansion bombs. Unknown keys are ignored.
- `setup` and `test` are shell commands by design. They only ever run inside the sandbox via `/exec`, never in the Worker or the FastAPI process.

## Consequences

- Reading the config costs one extra round-trip (`/file/read`) per task.
- `image:` is parsed but not acted on. Using it means the service choosing an image at `/session/create`, which happens before the file can be read. That will need the service, or a pre-clone step, to know the image. Revisit with the devcontainer fallback.
- The service doesn't need a YAML dependency.

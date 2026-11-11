# Glossary

**Task**
One unit of work for the factory, identified by its task ID. It runs in one `TaskCoordinator` Durable Object and one sandbox session. A task is either an **issue task** or a **prompt task**.

**Issue task**
A task created from a GitHub issue (`{repo, issue}` or an issue URL). The issue's repo is what gets checked out, and the issue's title and body become the prompt.

**Prompt task**
A task created from free text (`{prompt, repoUrl?, ref?}`). It's mostly used for tests and manual runs.

**Run**
One execution of a task: checkout, setup, the agent loop, and the final diff. Today each task has exactly one run.

**`.gantry.yml`**
A per-repo config file at the target repo's root. `setup:` holds the commands that run before the agent starts. `test:` is the command that verifies the agent's work. `image:` is reserved. See ADR 0002.

**Setup command**
A command from `setup:` that runs inside the sandbox after checkout and before the agent loop. A non-zero exit fails the task.

**Test command**
The `test:` command. The agent can run it through the `runTests` tool, and the factory will run it itself for red-green verification (rollout step 4).

**Verification**
Whether, and how, a run's result is checked by the factory rather than by the agent:
- `unverified`: the repo has no test command. The run can only ever produce a draft PR.
- `pending`: a test command exists, but factory verification hasn't been built yet (step 4 will set the outcome).
- Avoid "verified" to mean "the agent said tests pass". The agent doesn't grade itself.

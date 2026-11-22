# Deploying Gantry: the first live run

This takes the sandbox service to Modal and the control plane to Cloudflare, then runs one real issue task on [gantry-lakehouse](https://github.com/adamlefevre/gantry-lakehouse) and checks that its diff lands in R2. It assumes the changes that add `GANTRY_API_TOKEN`, the `sandbox-service` URL label and the endpoint timeout are merged.

Steps marked **(you)** need your own accounts or keys. Everything else is a command you can paste.

## 1. Accounts and tools

1. **(you)** Create a [Modal](https://modal.com) account.
2. **(you)** Create a [Cloudflare](https://dash.cloudflare.com) account. Enable R2 on it (the dashboard asks once).
3. **(you)** Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/apikey).
4. Install the tools and sign in from a terminal at the repo root:

   ```bash
   pip install -r requirements.txt   # the modal CLI
   modal setup                       # opens a browser to sign in to Modal
   npm ci
   (cd apps/control-plane && npx wrangler login)
   ```

## 2. Tokens

Gantry uses two random tokens of its own. Generate them and keep them in `.env` (copied from `.env.example`; it's gitignored):

```bash
cp .env.example .env
openssl rand -hex 32   # AGENT_SANDBOX_TOKEN: the Worker uses it to call the sandbox
openssl rand -hex 32   # GANTRY_API_TOKEN: you use it to call the Worker
```

Paste them, and your Gemini key, into `.env`. Never commit it or paste it into an issue or PR.

## 3. Sandbox service on Modal

```bash
set -a; source .env; set +a
modal secret create agent-sandbox-secret AGENT_SANDBOX_TOKEN="$AGENT_SANDBOX_TOKEN"
make modal-deploy
```

The deploy prints the endpoint URL, `https://<your-modal-workspace>--sandbox-service.modal.run`. Put it in `.env` as `MODAL_SANDBOX_URL`, then check that it is up and refuses calls without the token:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$MODAL_SANDBOX_URL/session/create"   # expect 401
```

## 4. Control plane on Cloudflare

```bash
set -a; source .env; set +a
cd apps/control-plane
npx wrangler r2 bucket create gantry
npx wrangler deploy --var MODAL_SANDBOX_URL:"$MODAL_SANDBOX_URL"
npx wrangler secret put AGENT_SANDBOX_TOKEN            # paste the same value as in .env
npx wrangler secret put GOOGLE_GENERATIVE_AI_API_KEY
npx wrangler secret put GANTRY_API_TOKEN
cd ../..
```

`--var` passes your Modal URL at deploy time, so your workspace name stays out of `wrangler.jsonc`. Pass it on every deploy. The deploy prints the Worker URL; put it in `.env` as `GANTRY_URL`. Check that the Worker refuses calls without the token:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$GANTRY_URL/api/tasks/ping/status"   # expect 401
```

Optional: `npx wrangler secret put GANTRY_MODEL` (or `--var GANTRY_MODEL:<id>`) switches the Gemini model. The default is `gemini-2.5-flash`.

## 5. The first live run

**(you)** Pick a small, clear issue on gantry-lakehouse (open one if there isn't one). Then:

```bash
set -a; source .env; set +a
./scripts/smoke-task.sh adamlefevre/gantry-lakehouse <issue-number>
```

The script starts the task, polls its status every 15 seconds for up to 30 minutes, then reads the task's telemetry from R2 and checks that the patch isn't empty. It ends with `First live run passed` or says what failed. While it runs, `wrangler tail` (from `apps/control-plane`) shows the Worker's logs, and the Modal dashboard shows the sandbox.

Nothing is pushed to gantry-lakehouse: the result is a diff in R2. Opening a PR from it is rollout step 3 (the GitHub App).

## If it fails

- **401 from the Worker:** `GANTRY_API_TOKEN` in `.env` doesn't match the Worker secret.
- **`Failed to initialize Modal Sandbox` in the steps or logs:** check `MODAL_SANDBOX_URL` (passed with `--var`) and that both sides have the same `AGENT_SANDBOX_TOKEN`.
- **`Setup command failed`:** the target repo's `.gantry.yml` setup didn't work in the sandbox image. The step's stderr is in `/api/tasks/<id>/steps`.
- **A Gemini error:** check the key, and try another model with `GANTRY_MODEL`.
- **The task stays RUNNING, or stops with no telemetry:** the agent loop runs in the Durable Object's `waitUntil`, which Cloudflare can cut short on long runs. Making runs resumable is rollout step 4, slices 1, 3 and 4 (`docs/design-notes/04-rollout-step-4-plan.md`). Try a smaller issue meanwhile.
- **Costs:** each run uses Gemini tokens and Modal sandbox time. Delete the deployments (`modal app stop agent-sandbox-service`, `npx wrangler delete`) if you stop using them.

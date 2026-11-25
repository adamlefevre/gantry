# Deploying Gantry: the first live run

This takes the sandbox service to Modal and the control plane to Cloudflare, then runs one real issue task on [gantry-lakehouse](https://github.com/adamlefevre/gantry-lakehouse) and checks that its diff lands in R2. It assumes the changes that add `GANTRY_API_TOKEN`, the `sandbox-service` URL label and the endpoint timeout, and the change that runs the agent on Claude (ADR 0005), are merged.

Steps marked **(you)** need your own accounts or keys. Everything else is a command you can paste.

No terminal handy? [Deploying from GitHub](#deploying-from-github) does sections 3 to 5 from the repo's Actions tab, in any browser.

## 1. Accounts and tools

1. **(you)** Create a [Modal](https://modal.com) account.
2. **(you)** Create a [Cloudflare](https://dash.cloudflare.com) account. Enable R2 on it (the dashboard asks once).
3. **(you)** Create an Anthropic API key in the [Claude Console](https://platform.claude.com/), under API keys, and add billing credit to its organization. The agent runs on Claude Opus 5.5 by default.
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

Paste them, and your Anthropic key, into `.env`. Never commit it or paste it into an issue or PR.

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
npx wrangler secret put ANTHROPIC_API_KEY              # your Anthropic key
npx wrangler secret put GANTRY_API_TOKEN
cd ../..
```

`--var` passes your Modal URL at deploy time, so your workspace name stays out of `wrangler.jsonc`. Pass it on every deploy. The deploy prints the Worker URL; put it in `.env` as `GANTRY_URL`. Check that the Worker refuses calls without the token:

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$GANTRY_URL/api/tasks/ping/status"   # expect 401
```

Gantry only checks out the repos named in `GANTRY_ALLOWED_REPOS` (comma-separated `owner/name` or `owner/*`; `wrangler.jsonc` sets `adamlefevre/gantry-lakehouse`). A task for any other repo gets a 403, and with the list empty every repo task does. Edit the list in `wrangler.jsonc`, or pass `--var GANTRY_ALLOWED_REPOS:owner/name,owner/other` on every deploy. Tasks may name a branch, tag or commit SHA, but not a `refs/...` name such as `refs/pull/1/head`, so an outsider's pull request can't run as the repo's own code.

Optional, on the deploy command: `--var GANTRY_MODEL:<id>` switches the Claude model (default `claude-opus-5-5`; any Claude 4.6 or later model works, such as `claude-sonnet-5-5`), and `--var GANTRY_EFFORT:<level>` sets how hard it thinks (`low`, `medium`, `high` (the default), `xhigh` or `max`). Like `MODAL_SANDBOX_URL`, pass them on every deploy.

## 5. The first live run

**(you)** Pick a small, clear issue on gantry-lakehouse (open one if there isn't one). Then:

```bash
set -a; source .env; set +a
./scripts/smoke-task.sh adamlefevre/gantry-lakehouse <issue-number>
```

The script starts the task, polls its status every 15 seconds for up to 30 minutes, then reads the task's telemetry from R2 and checks that the patch isn't empty. It ends with `First live run passed` or says what failed. While it runs, `wrangler tail` (from `apps/control-plane`) shows the Worker's logs, and the Modal dashboard shows the sandbox.

Nothing is pushed to gantry-lakehouse: the result is a diff in R2. Opening a PR from it is rollout step 3 (the GitHub App).

## Deploying from GitHub

The Deploy workflow (`.github/workflows/deploy.yml`) does sections 3 and 4, and optionally 5, on GitHub's runners, so you need only a browser. It deploys only from `main`.

1. **(you)** On Modal's website: **Settings > API Tokens > New Token**. Keep the token ID and secret.
2. **(you)** On Cloudflare's dashboard: **My Profile > API Tokens > Create Token**, with the **Edit Cloudflare Workers** template. Make sure it includes **Workers R2 Storage: Edit**, and add it if not. Also copy your **Account ID** from the account's home page.
3. **(you)** Get an Anthropic API key as in section 1.
4. **(you)** Make two long random tokens for `AGENT_SANDBOX_TOKEN` and `GANTRY_API_TOKEN`. A 40-character password from a password manager works.
5. **(you)** On GitHub, in the repo's **Settings > Environments**, create an environment named `production`. Under **Deployment branches and tags**, choose **Selected branches and tags** and add `main`, so no other branch can use its secrets. Then, under **Environment secrets**, add each of these (not as repository secrets, which every workflow and branch could read):

   | Secret | Value |
   |---|---|
   | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` | the Modal token from step 1 |
   | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | the Cloudflare token and account ID from step 2 |
   | `ANTHROPIC_API_KEY` | your Anthropic key |
   | `AGENT_SANDBOX_TOKEN`, `GANTRY_API_TOKEN` | the two tokens from step 4 |
   | `GANTRY_GITHUB_TOKEN` (optional, recommended) | a GitHub fine-grained token, read-only: **Settings > Developer settings > Fine-grained tokens**, repository access to gantry-lakehouse, permissions **Issues: Read** (Metadata: Read comes with it). The Worker uses it to fetch issues; without it GitHub often rate-limits Cloudflare's shared IPs |

   A secret set in another repo doesn't carry over, and GitHub never shows a saved value again, so use the values you kept, or make new ones.

6. **(you)** **Actions > Deploy > Run workflow**, on `main`. Leave the target at `both`. To do the first live run in the same go, put a gantry-lakehouse issue number in the issue box.

The run stores `AGENT_SANDBOX_TOKEN` as the Modal secret `agent-sandbox-secret` and sets the Worker's secrets (three, plus `GITHUB_TOKEN` when `GANTRY_GITHUB_TOKEN` is set), so GitHub is the one place to change them. It creates the R2 bucket if it's missing, deploys both services, and checks that each refuses calls without its token. Each secret reaches only the steps that use it, and the actions and the Modal CLI are pinned to exact versions (the CLI's are hash-checked, in `requirements.lock`), npm installs skip install scripts, and Dependabot opens a PR when a pinned action has a new release. Its summary page shows the two URLs. Keep `GANTRY_API_TOKEN` and the Worker URL to call Gantry yourself.

Optional variables (on the environment, or the repo's **Secrets and variables > Actions > Variables** tab): `GANTRY_MODEL` and `GANTRY_EFFORT` as in section 4, and `MODAL_SANDBOX_URL` and `GANTRY_URL` for runs that deploy only the Worker or can't read a URL from the deploy output.

To deploy automatically after every merge to `main` whose CI passes, uncomment the four `workflow_run` lines at the top of the workflow.

If you also deploy from a terminal, keep the tokens in `.env` the same as the GitHub secrets, because each deploy from GitHub overwrites the Modal and Worker secrets.

## If it fails

- **401 from the Worker:** `GANTRY_API_TOKEN` in `.env` doesn't match the Worker secret.
- **`Failed to initialize Modal Sandbox` in the steps or logs:** check `MODAL_SANDBOX_URL` (passed with `--var`) and that both sides have the same `AGENT_SANDBOX_TOKEN`.
- **`Setup command failed`:** the target repo's `.gantry.yml` setup didn't work in the sandbox image. The step's stderr is in `/api/tasks/<id>/steps`.
- **`The Worker refused the task: ... GitHub API rate limit reached` (503):** the Worker fetched the issue without a token and GitHub limited it. Add `GANTRY_GITHUB_TOKEN` (step 5) and run Deploy again.
- **An Anthropic error** (`401`, `403` or `429` in the logs): check `ANTHROPIC_API_KEY` and that its organization has credit. `The model declined to continue` means Claude refused the task, even after its fallback model tried; try a different issue.
- **The task stays RUNNING, or stops with no telemetry:** the agent loop runs in the Durable Object's `waitUntil`, which Cloudflare can cut short on long runs. Making runs resumable is rollout step 4, slices 1, 3 and 4 (`docs/design-notes/04-rollout-step-4-plan.md`). Try a smaller issue meanwhile.
- **Costs:** each run uses Claude tokens and Modal sandbox time. Claude Opus 5.5 costs $4 per million input tokens and $20 per million output tokens, and the loop caches the conversation so each turn re-reads it at a tenth of that input price. `GANTRY_EFFORT:medium` or `GANTRY_MODEL:claude-sonnet-5-5` ($2 and $10) costs less. The Claude Console's usage page shows what each run spent. Each task stops after 3,000,000 tokens (`budgets.maxTotalTokens` in `agent-config.json`), and a second start on a task ID that is still running gets a 409. To cap the total too, create the key in its own Claude Console workspace and set a monthly spend limit on that workspace. Delete the deployments (`modal app stop agent-sandbox-service`, `npx wrangler delete`) if you stop using them.

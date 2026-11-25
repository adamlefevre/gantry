#!/usr/bin/env bash
# First live run check: start one issue task on the deployed control
# plane, wait for it to finish, and check that its telemetry, with a non-empty patch, is in R2.
#
#   GANTRY_URL=https://gantry-control-plane.<subdomain>.workers.dev \
#   GANTRY_API_TOKEN=... \
#   ./scripts/smoke-task.sh adamlefevre/gantry-lakehouse 12
#
# Needs curl and node, and `npx wrangler login` done (it reads the object from R2). Wrangler 3
# (pinned in apps/control-plane) reads remote R2 by default; on Wrangler 4, add --remote.
set -euo pipefail

repo="${1:?usage: $0 owner/name issue-number}"
issue="${2:?usage: $0 owner/name issue-number}"
: "${GANTRY_URL:?set GANTRY_URL to the Worker URL}"
: "${GANTRY_API_TOKEN:?set GANTRY_API_TOKEN (the Worker secret of the same name)}"
bucket="${GANTRY_BUCKET_NAME:-gantry}"
timeout_seconds="${SMOKE_TIMEOUT_SECONDS:-1800}"
task_id="smoke-$(date -u +%Y%m%d-%H%M%S)"
here="$(cd "$(dirname "$0")" && pwd)"

api() {
  # The token goes in a header read from stdin, so it never shows up in `ps`.
  local method="$1" path="$2"
  shift 2
  printf 'Authorization: Bearer %s\n' "$GANTRY_API_TOKEN" |
    curl -sS --fail-with-body -X "$method" -H @- "$@" "${GANTRY_URL%/}/api/tasks/${task_id}/${path}"
}

# Prints one expression over the JSON on stdin, e.g. `json 'o.task.status'`.
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=new Function("o","return "+process.argv[1])(JSON.parse(s));console.log(v??"")})' "$1"; }

echo "Starting ${task_id}: ${repo}#${issue}"
# On an error, --fail-with-body still prints the Worker's message, so show it rather than discard it.
if ! started="$(api POST start -H "Content-Type: application/json" -d "{\"repo\":\"${repo}\",\"issue\":${issue}}")"; then
  echo "The Worker refused the task: ${started:-no message}" >&2
  exit 1
fi

deadline=$((SECONDS + timeout_seconds))
status=""
while (( SECONDS < deadline )); do
  status="$(api GET status | json 'o.task && o.task.status')"
  echo "  $(date -u +%H:%M:%S) ${status:-QUEUED}"
  [[ "$status" == "RESOLVED" || "$status" == "FAILED" ]] && break
  sleep 15
done

steps="$(api GET steps | json 'o.steps.length')"
echo "Finished: ${status:-timed out} after ${steps} steps"
[[ "$status" == "RESOLVED" ]] || { echo "The task did not resolve. Read its steps at /api/tasks/${task_id}/steps." >&2; exit 1; }

# The key's year and month are UTC, from when the task finished (docs/telemetry.md).
key="telemetry/year=$(date -u +%Y)/month=$(date -u +%m)/${task_id}.json"
record="$(cd "$here/../apps/control-plane" && npx wrangler r2 object get "${bucket}/${key}" --pipe)"
patch_lines="$(printf '%s' "$record" | json 'o.patch.split("\n").filter(l=>/^[+-](?![+-])/.test(l)).length')"
echo "R2 ${bucket}/${key}: model $(printf '%s' "$record" | json 'o.model'), ${patch_lines} changed lines"
(( patch_lines > 0 )) || { echo "The telemetry has an empty patch." >&2; exit 1; }
echo "First live run passed: the task's diff is in R2."

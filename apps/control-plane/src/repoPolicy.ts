import { TaskInputError } from "./github";

/**
 * Which repos the factory may check out, and which refs. Target-repo content runs in the
 * sandbox (setup and test commands, code, AGENTS.md), so the operator names the repos up
 * front instead of trusting whatever a request points at.
 *
 * GANTRY_ALLOWED_REPOS is a comma-separated list of `owner/name` or `owner/*`, matched without
 * regard to case. Unset or empty: every task that checks out a repo is refused (fail closed);
 * prompt tasks with no repo still run.
 */
export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export function isAllowed(allowlist: string[], owner: string, repo: string): boolean {
  const o = owner.toLowerCase();
  const full = `${o}/${repo.toLowerCase()}`;
  return allowlist.some((entry) => entry === full || entry === `${o}/*`);
}

/** Throws 403 unless the repo is on the allowlist. */
export function requireAllowed(allowlist: string[], owner: string, repo: string): void {
  if (allowlist.length === 0) {
    throw new TaskInputError(403, "no repos are allowed: set GANTRY_ALLOWED_REPOS to the repos Gantry may work on");
  }
  if (!isAllowed(allowlist, owner, repo)) {
    throw new TaskInputError(403, `${owner}/${repo} is not in GANTRY_ALLOWED_REPOS`);
  }
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const GITHUB_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

/** `https://github.com/owner/name` (optionally `.git` or a trailing slash), or null for anything else. */
export function githubRepoFromUrl(url: string): { owner: string; repo: string } | null {
  const m = url.match(GITHUB_URL_RE);
  if (!m) return null;
  const [, owner, repo] = m;
  if (!OWNER_RE.test(owner) || !NAME_RE.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo };
}

// A branch, tag or commit SHA, as the sandbox accepts it. Full ref names (`refs/...`) are
// refused, which keeps out `refs/pull/N/head`: an outsider's pull request, run as if it were
// the repo's own code.
const REF_RE = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

export function validateRef(ref: string): void {
  if (ref.length > 255 || !REF_RE.test(ref) || ref.includes("..") || ref.toLowerCase().startsWith("refs/")) {
    throw new TaskInputError(400, "ref must be a branch, tag or commit SHA (not a refs/... name)");
  }
}

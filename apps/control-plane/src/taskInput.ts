import { fetchIssue, issueToPrompt, parseIssueRef, TaskInputError, type GitHubClientOptions } from "./github";
import type { RepoTarget } from "./agent";
import { githubRepoFromUrl, requireAllowed, validateRef } from "./repoPolicy";

/**
 * Body of POST /api/tasks/:id/start. Two shapes:
 *   - issue task: `{repo: "owner/name", issue: 12}` or `{issue: "https://github.com/owner/name/issues/12"}`,
 *     plus optional `ref` and `prompt` (extra operator instructions).
 *   - prompt task: `{prompt, repoUrl?, ref?}`.
 */
export interface TaskStartBody {
  taskId?: string;
  prompt?: string;
  /** `https://github.com/owner/name` to clone into the sandbox (must be allowed). Omit to start with an empty workspace. */
  repoUrl?: string;
  /** Branch, tag, or commit SHA (not a `refs/...` name). Defaults to the remote's HEAD. */
  ref?: string;
  /** "owner/name", used with a numeric `issue`. */
  repo?: string;
  /** Issue number, "#12", or a github.com issue URL. */
  issue?: number | string;
}

export interface TaskInput {
  prompt: string;
  repo?: RepoTarget;
  /** The issue as it was read: `updatedAt` from GitHub, and a SHA-256 of its title and full body. */
  issue?: { number: number; url: string; updatedAt: string | null; sha256: string };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `allowedRepos`: the parsed GANTRY_ALLOWED_REPOS (see repoPolicy.ts). */
export async function resolveTaskInput(
  body: TaskStartBody,
  github: GitHubClientOptions,
  allowedRepos: string[]
): Promise<TaskInput> {
  if (body.ref !== undefined && typeof body.ref !== "string") {
    throw new TaskInputError(400, "ref must be a string");
  }
  const ref = body.ref || "HEAD";
  validateRef(ref);
  if (body.prompt !== undefined && typeof body.prompt !== "string") {
    throw new TaskInputError(400, "prompt must be a string");
  }

  if (body.issue !== undefined) {
    const issueRef = parseIssueRef(body.repo, body.issue);
    // Before the GitHub call: a repo that isn't allowed costs nothing.
    requireAllowed(allowedRepos, issueRef.owner, issueRef.repo);
    const issue = await fetchIssue(issueRef, github);
    if (body.repoUrl && body.repoUrl.replace(/(\.git)?\/?$/, "") !== issue.repoUrl) {
      throw new TaskInputError(400, "repoUrl does not match the issue's repo");
    }
    return {
      prompt: issueToPrompt(issue, body.prompt || undefined),
      repo: { url: issue.repoUrl, ref },
      issue: {
        number: issue.number,
        url: issue.url,
        updatedAt: issue.updatedAt,
        sha256: await sha256Hex(`${issue.title}\n\n${issue.body}`),
      },
    };
  }

  if (!body.prompt) {
    throw new TaskInputError(400, "provide either an issue ({repo, issue} or an issue URL) or a prompt");
  }
  if (body.repoUrl === undefined || body.repoUrl === "") {
    return { prompt: body.prompt };
  }
  const target = typeof body.repoUrl === "string" ? githubRepoFromUrl(body.repoUrl) : null;
  if (!target) {
    throw new TaskInputError(400, "repoUrl must look like https://github.com/owner/name");
  }
  requireAllowed(allowedRepos, target.owner, target.repo);
  return {
    prompt: body.prompt,
    repo: { url: `https://github.com/${target.owner}/${target.repo}`, ref },
  };
}

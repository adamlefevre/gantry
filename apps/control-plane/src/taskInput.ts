import { fetchIssue, issueToPrompt, parseIssueRef, TaskInputError, type GitHubClientOptions } from "./github";
import type { RepoTarget } from "./agent";

/**
 * Body of POST /api/tasks/:id/start. Two shapes:
 *   - issue task: `{repo: "owner/name", issue: 12}` or `{issue: "https://github.com/owner/name/issues/12"}`,
 *     plus optional `ref` and `prompt` (extra operator instructions).
 *   - prompt task: `{prompt, repoUrl?, ref?}`.
 */
export interface TaskStartBody {
  taskId?: string;
  prompt?: string;
  /** Public https git URL to clone into the sandbox. Omit to start with an empty workspace. */
  repoUrl?: string;
  /** Branch, tag, or commit SHA. Defaults to the remote's HEAD. */
  ref?: string;
  /** "owner/name", used with a numeric `issue`. */
  repo?: string;
  /** Issue number, "#12", or a github.com issue URL. */
  issue?: number | string;
}

export interface TaskInput {
  prompt: string;
  repo?: RepoTarget;
  issue?: { number: number; url: string };
}

export async function resolveTaskInput(body: TaskStartBody, github: GitHubClientOptions): Promise<TaskInput> {
  const ref = body.ref || "HEAD";
  if (body.prompt !== undefined && typeof body.prompt !== "string") {
    throw new TaskInputError(400, "prompt must be a string");
  }

  if (body.issue !== undefined) {
    const issueRef = parseIssueRef(body.repo, body.issue);
    const issue = await fetchIssue(issueRef, github);
    if (body.repoUrl && body.repoUrl.replace(/(\.git)?\/?$/, "") !== issue.repoUrl) {
      throw new TaskInputError(400, "repoUrl does not match the issue's repo");
    }
    return {
      prompt: issueToPrompt(issue, body.prompt || undefined),
      repo: { url: issue.repoUrl, ref },
      issue: { number: issue.number, url: issue.url },
    };
  }

  if (!body.prompt) {
    throw new TaskInputError(400, "provide either an issue ({repo, issue} or an issue URL) or a prompt");
  }
  return {
    prompt: body.prompt,
    repo: body.repoUrl ? { url: body.repoUrl, ref } : undefined,
  };
}

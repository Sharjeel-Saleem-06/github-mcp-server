import { Octokit } from "@octokit/rest";

export function confirmationBlock(action: string, details: Record<string, string>): string {
  return [
    `⚠️  CONFIRMATION REQUIRED`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Action  : ${action}`,
    ...Object.entries(details).map(([k, v]) => `${k.padEnd(8)}: ${v}`),
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Reply "yes, confirm" to proceed or "cancel" to abort.`,
    `This will NOT execute until you explicitly confirm.`,
  ].join("\n");
}

export function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function err(message: string) {
  return { content: [{ type: "text" as const, text: `❌ Error: ${message}` }], isError: true as const };
}

export function githubError(e: any): ReturnType<typeof err> {
  const s = e?.status;
  if (s === 401) return err("401 Unauthorized — token expired or missing permissions.");
  if (s === 403) return err("403 Forbidden — token lacks required permission for this action.");
  if (s === 404) return err("404 Not Found — check repo, branch, or file path (case-sensitive).");
  if (s === 409) return err("409 Conflict — resource already exists or merge conflict detected.");
  if (s === 422) return err(`422 Unprocessable — ${e?.message ?? "invalid input or name conflict"}`);
  return err(e?.message ?? "Unknown GitHub API error");
}

/**
 * Resolve owner: use provided value, or fall back to the authenticated username.
 */
export async function resolveOwner(octokit: Octokit, provided?: string): Promise<string> {
  if (provided) return provided;
  const { data } = await octokit.users.getAuthenticated();
  return data.login;
}

/**
 * Get default branch for a repo.
 */
export async function defaultBranch(octokit: Octokit, owner: string, repo: string): Promise<string> {
  const { data } = await octokit.repos.get({ owner, repo });
  return data.default_branch;
}

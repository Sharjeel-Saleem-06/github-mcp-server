/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  GitHub MCP Server — Cloudflare Workers Edition                 ║
 * ║                                                                  ║
 * ║  FREE TIER: 100,000 requests/day                                 ║
 * ║  Always-on, no cold starts, global edge network                  ║
 * ║                                                                  ║
 * ║  Deploy: npx wrangler deploy                                     ║
 * ║  URL: https://github-mcp-server.<your-subdomain>.workers.dev     ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * MCP config for Claude Desktop / Cursor / any MCP client:
 * {
 *   "github": {
 *     "url": "https://github-mcp-server.<subdomain>.workers.dev/mcp",
 *     "headers": { "Authorization": "Bearer YOUR_MCP_SECRET_KEY" }
 *   }
 * }
 */

import { Octokit } from "@octokit/rest";
import { toolDefinitions } from "./tools/definitions.js";

// ─── Cloudflare Workers Env bindings ─────────────────────────────────────────
interface Env {
  GITHUB_TOKEN:    string;
  GITHUB_USERNAME: string;
  MCP_SECRET_KEY:  string;
}

// ─── Auth helper ──────────────────────────────────────────────────────────────
function isAuthorized(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization") ?? "";
  return auth === `Bearer ${env.MCP_SECRET_KEY}`;
}

// ─── CORS headers ─────────────────────────────────────────────────────────────
function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
  };
}

// ─── Worker entry point ───────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Health check — public, safe
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json(
        { status: "ok", name: "github-mcp-server", version: "3.0.0", tools: toolDefinitions.length },
        { headers: corsHeaders() }
      );
    }

    // All MCP endpoints require auth
    if (!isAuthorized(request, env)) {
      return Response.json(
        { error: "Unauthorized", hint: "Include header: Authorization: Bearer <MCP_SECRET_KEY>" },
        { status: 401, headers: corsHeaders() }
      );
    }

    // MCP endpoint — direct JSON-RPC handler (Workers-native, no Node.js transport needed)
    if (url.pathname === "/mcp") {
      if (request.method !== "POST") {
        return Response.json({ error: "MCP endpoint requires POST" }, { status: 405, headers: corsHeaders() });
      }

      let body: any;
      try { body = await request.json(); } catch {
        return Response.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, { status: 400, headers: corsHeaders() });
      }

      const octokit = new Octokit({ auth: env.GITHUB_TOKEN });
      const result  = await handleJsonRpc(body, octokit, env.GITHUB_USERNAME);

      return Response.json(result, { headers: { ...corsHeaders(), "Content-Type": "application/json" } });
    }

    return Response.json({ error: "Not found" }, { status: 404, headers: corsHeaders() });
  },
};

// ─── JSON-RPC handler — runs the tool call and returns a JSON-RPC response ────
// This is a Workers-native approach: pure JSON in, pure JSON out. No Node.js
// transports needed. Claude Desktop sends POST /mcp with a JSON-RPC body.
async function handleJsonRpc(body: any, octokit: Octokit, USERNAME: string): Promise<any> {
  // Handle tools/list — Claude fetches available tools on startup
  if (body.method === "tools/list") {
    return { jsonrpc: "2.0", id: body.id, result: { tools: toolDefinitions } };
  }

  // Handle initialize — required handshake
  if (body.method === "initialize") {
    return { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "github-mcp-server", version: "3.0.0" } } };
  }

  // Handle notifications (no response needed)
  if (body.method?.startsWith("notifications/") || body.id === undefined) {
    return null;
  }

  // Handle tools/call
  if (body.method === "tools/call") {
    const toolResult = await dispatchTool(body.params?.name, body.params?.arguments ?? {}, octokit, USERNAME);
    return { jsonrpc: "2.0", id: body.id, result: toolResult };
  }

  // Unknown method
  return { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `Method not found: ${body.method}` } };
}

// ─── Tool dispatcher ─────────────────────────────────────────────────────────
async function dispatchTool(name: string, a: Record<string, any>, octokit: Octokit, USERNAME: string): Promise<any> {
    const owner = (a?.owner as string) || USERNAME;

    const ok  = (text: string) => ({ content: [{ type: "text" as const, text }] });
    const err = (msg: string)  => ({ content: [{ type: "text" as const, text: `❌ ${msg}` }], isError: true as const });

    function githubErr(e: any) {
      if (e?.status === 401) return err("401 Unauthorized — check your GitHub token permissions.");
      if (e?.status === 403) return err("403 Forbidden — token lacks required scope for this action.");
      if (e?.status === 404) return err("404 Not Found — check repo/branch/file name (case-sensitive).");
      if (e?.status === 422) return err(`422 Unprocessable — ${e?.message ?? "invalid input"}`);
      return err(e?.message ?? "Unknown GitHub API error");
    }

    function confirmBlock(action: string, details: Record<string, string>): string {
      return [
        `⚠️  CONFIRMATION REQUIRED`,
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `Action: ${action}`,
        ...Object.entries(details).map(([k, v]) => `${k.padEnd(8)}: ${v}`),
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `Reply with "yes, confirm" to proceed or "cancel" to abort.`,
      ].join("\n");
    }

    async function getDefaultBranch(repo: string): Promise<string> {
      const { data } = await octokit.repos.get({ owner, repo });
      return data.default_branch;
    }

    try {
      switch (name) {
        // ── REPOS ─────────────────────────────────────────────────────────────
        case "list_repos": {
          const { data } = await octokit.repos.listForAuthenticatedUser({ sort: "updated", per_page: (a?.per_page as number) ?? 30, type: (a?.type as any) ?? "all" });
          return ok(`${data.length} repos:\n\n${data.map(r => `📁 ${r.full_name} [${r.private ? "🔒" : "🌍"}] ${r.language ?? ""}\n   ⭐${r.stargazers_count} — ${r.description ?? "no description"}\n   ${r.html_url}`).join("\n\n")}`);
        }
        case "get_repo": {
          const { data: d } = await octokit.repos.get({ owner, repo: a?.repo as string });
          return ok([`📦 ${d.full_name}`, `Description : ${d.description ?? "none"}`, `Visibility  : ${d.private ? "🔒 private" : "🌍 public"}`, `Language    : ${d.language ?? "unknown"}`, `Default br  : ${d.default_branch}`, `Stars ⭐    : ${d.stargazers_count}  Forks 🍴: ${d.forks_count}`, `Open issues : ${d.open_issues_count}`, `Created     : ${d.created_at?.slice(0,10)}`, `Last push   : ${d.pushed_at?.slice(0,10)}`, `URL         : ${d.html_url}`].join("\n"));
        }
        case "create_repo": {
          const { data: d } = await octokit.repos.createForAuthenticatedUser({ name: a?.name as string, description: (a?.description as string) ?? "", private: (a?.private as boolean) ?? false, auto_init: (a?.auto_init as boolean) ?? true });
          return ok(`✅ Repo created!\nName : ${d.full_name}\nURL  : ${d.html_url}\nClone: ${d.clone_url}`);
        }
        case "delete_repo": {
          if (!a?.confirmed) return ok(confirmBlock("DELETE REPOSITORY", { Repo: `${owner}/${a?.repo}`, WARNING: "PERMANENT — deletes everything" }));
          await octokit.repos.delete({ owner, repo: a?.repo as string });
          return ok(`🗑️  ${owner}/${a?.repo} permanently deleted.`);
        }
        case "search_repos": {
          const { data } = await octokit.search.repos({ q: a?.query as string, per_page: (a?.per_page as number) ?? 10 });
          return ok(`${data.total_count} results:\n\n${data.items.map(r => `📁 ${r.full_name} ⭐${r.stargazers_count}\n   ${r.description ?? ""}\n   ${r.html_url}`).join("\n\n")}`);
        }
        case "fork_repo": {
          const { data: d } = await octokit.repos.createFork({ owner: a?.owner as string, repo: a?.repo as string });
          return ok(`✅ Forked!\n${d.full_name}\n${d.html_url}`);
        }
        case "update_repo_settings": {
          const p: any = { owner, repo: a?.repo as string };
          if (a?.description !== undefined) p.description = a.description;
          if (a?.private     !== undefined) p.private     = a.private;
          if (a?.has_issues  !== undefined) p.has_issues  = a.has_issues;
          const { data: d } = await octokit.repos.update(p);
          return ok(`✅ Settings updated: ${d.full_name}`);
        }
        case "get_repo_topics": {
          const { data } = await octokit.repos.getAllTopics({ owner, repo: a?.repo as string });
          return ok(`Topics: ${data.names.join(", ") || "(none)"}`);
        }
        case "set_repo_topics": {
          await octokit.repos.replaceAllTopics({ owner, repo: a?.repo as string, names: a?.topics as string[] });
          return ok(`✅ Topics set: ${(a?.topics as string[]).join(", ")}`);
        }

        // ── BRANCHES ──────────────────────────────────────────────────────────
        case "list_branches": {
          const { data } = await octokit.repos.listBranches({ owner, repo: a?.repo as string, per_page: 100 });
          return ok(`Branches (${data.length}):\n${data.map((b, i) => `${i+1}. ${b.name.padEnd(30)} ${b.commit.sha.slice(0,7)} ${b.protected ? "🔒" : ""}`).join("\n")}`);
        }
        case "get_branch": {
          const { data: d } = await octokit.repos.getBranch({ owner, repo: a?.repo as string, branch: a?.branch as string });
          return ok(`🌿 ${d.name}\nSHA: ${d.commit.sha}\nProtected: ${d.protected ? "Yes 🔒" : "No"}`);
        }
        case "create_branch": {
          const db   = await getDefaultBranch(a?.repo as string);
          const from = (a?.from_branch as string) ?? db;
          const { data: ref } = await octokit.git.getRef({ owner, repo: a?.repo as string, ref: `heads/${from}` });
          await octokit.git.createRef({ owner, repo: a?.repo as string, ref: `refs/heads/${a?.new_branch}`, sha: ref.object.sha });
          return ok(`✅ Branch '${a?.new_branch}' created from '${from}' (${ref.object.sha.slice(0,7)})`);
        }
        case "delete_branch": {
          if (!a?.confirmed) return ok(confirmBlock("DELETE BRANCH", { Repo: `${owner}/${a?.repo}`, Branch: a?.branch as string, WARNING: "Unmerged commits lost" }));
          await octokit.git.deleteRef({ owner, repo: a?.repo as string, ref: `heads/${a?.branch}` });
          return ok(`🗑️  Branch '${a?.branch}' deleted.`);
        }
        case "rename_branch": {
          await octokit.repos.renameBranch({ owner, repo: a?.repo as string, branch: a?.branch as string, new_name: a?.new_name as string });
          return ok(`✅ Branch renamed: ${a?.branch} → ${a?.new_name}`);
        }
        case "get_branch_protection": {
          try {
            const { data: d } = await octokit.repos.getBranchProtection({ owner, repo: a?.repo as string, branch: a?.branch as string });
            return ok(`🔒 Protection on '${a?.branch}'\nPR reviews required: ${d.required_pull_request_reviews ? "Yes" : "No"}\nEnforce admins: ${d.enforce_admins?.enabled ? "Yes" : "No"}`);
          } catch { return ok(`No protection rules on '${a?.branch}'.`); }
        }

        // ── COMMITS ───────────────────────────────────────────────────────────
        case "list_commits": {
          const db = await getDefaultBranch(a?.repo as string);
          const p: any = { owner, repo: a?.repo as string, sha: (a?.branch as string) ?? db, per_page: (a?.per_page as number) ?? 15 };
          if (a?.since)  p.since  = new Date(a.since  as string).toISOString();
          if (a?.author) p.author = a.author;
          const { data } = await octokit.repos.listCommits(p);
          return ok(`Commits (${data.length}):\n${data.map((c, i) => `${i+1}. ${c.sha.slice(0,7)} | ${c.commit.author?.date?.slice(0,10)} | ${(c.commit.author?.name ?? "?").padEnd(18)} | ${c.commit.message.split("\n")[0]}`).join("\n")}`);
        }
        case "get_commit_diff": {
          const { data: d } = await octokit.repos.getCommit({ owner, repo: a?.repo as string, ref: a?.commit_sha as string });
          return ok([`📝 ${d.sha.slice(0,7)} — ${d.commit.message}`, `Author : ${d.commit.author?.name} | ${d.commit.author?.date?.slice(0,10)}`, "", "Files changed:", ...(d.files ?? []).map(f => `  ${f.status.toUpperCase().padEnd(8)} ${f.filename}  +${f.additions} -${f.deletions}`), ``, `Total: +${d.stats?.additions} -${d.stats?.deletions}`].join("\n"));
        }
        case "compare_branches": {
          const { data: d } = await octokit.repos.compareCommitsWithBasehead({ owner, repo: a?.repo as string, basehead: `${a?.base}...${a?.head}` });
          return ok([`📊 '${a?.base}' vs '${a?.head}'`, `Ahead: ${d.ahead_by} | Behind: ${d.behind_by} | Files: ${d.files?.length ?? 0}`, "", `Commits in '${a?.head}':`, ...d.commits.map(c => `  ${c.sha.slice(0,7)} ${c.commit.message.split("\n")[0]}`)].join("\n"));
        }
        case "get_commit_history": {
          const db = await getDefaultBranch(a?.repo as string);
          const branch = (a?.branch as string) ?? db;
          const { data } = await octokit.repos.listCommits({ owner, repo: a?.repo as string, sha: branch, per_page: (a?.per_page as number) ?? 20 });
          return ok(`📜 History on '${branch}':\n${"─".repeat(70)}\n${data.map(c => `${c.sha.slice(0,7)}  ${c.commit.author?.date?.slice(0,10)}  ${(c.commit.author?.name ?? "?").slice(0,18).padEnd(20)}  ${c.commit.message.split("\n")[0].slice(0,50)}`).join("\n")}`);
        }

        // ── FILES ─────────────────────────────────────────────────────────────
        case "get_file_contents": {
          const db  = await getDefaultBranch(a?.repo as string);
          const { data: d } = await octokit.repos.getContent({ owner, repo: a?.repo as string, path: a?.path as string, ref: (a?.branch as string) ?? db });
          if ("content" in d && !Array.isArray(d)) {
            const text = Buffer.from(d.content, "base64").toString("utf-8");
            return ok(`📄 ${d.path}  (${d.size} bytes)\n\n${text}`);
          }
          return ok("That path is a directory. Use list_directory instead.");
        }
        case "list_directory": {
          const db  = await getDefaultBranch(a?.repo as string);
          const { data: d } = await octokit.repos.getContent({ owner, repo: a?.repo as string, path: (a?.path as string) ?? "", ref: (a?.branch as string) ?? db });
          if (Array.isArray(d)) return ok(d.map(i => `${i.type === "dir" ? "📁" : "📄"} ${i.name.padEnd(38)} ${i.type === "file" ? `${i.size}b` : ""}`).join("\n"));
          return ok("That path is a file. Use get_file_contents.");
        }
        case "create_or_update_file": {
          if (!a?.confirmed) return ok(confirmBlock("CREATE/UPDATE FILE", { Repo: `${owner}/${a?.repo}`, File: a?.path as string, Commit: a?.message as string }));
          const db     = await getDefaultBranch(a?.repo as string);
          const branch = (a?.branch as string) ?? db;
          const content = Buffer.from(a?.content as string).toString("base64");
          let sha: string | undefined;
          try { const { data: ex } = await octokit.repos.getContent({ owner, repo: a?.repo as string, path: a?.path as string, ref: branch }); if (!Array.isArray(ex) && "sha" in ex) sha = ex.sha; } catch {}
          const { data: d } = await octokit.repos.createOrUpdateFileContents({ owner, repo: a?.repo as string, path: a?.path as string, message: a?.message as string, content, branch, sha });
          return ok(`✅ File ${sha ? "updated" : "created"}! Commit: ${d.commit.sha?.slice(0,7)}\n${d.content?.html_url}`);
        }
        case "delete_file": {
          if (!a?.confirmed) return ok(confirmBlock("DELETE FILE", { Repo: `${owner}/${a?.repo}`, File: a?.path as string }));
          const db     = await getDefaultBranch(a?.repo as string);
          const branch = (a?.branch as string) ?? db;
          const { data: ex } = await octokit.repos.getContent({ owner, repo: a?.repo as string, path: a?.path as string, ref: branch });
          if (Array.isArray(ex) || !("sha" in ex)) return ok("That path is a directory.");
          await octokit.repos.deleteFile({ owner, repo: a?.repo as string, path: a?.path as string, message: a?.message as string, sha: ex.sha, branch });
          return ok(`🗑️  '${a?.path}' deleted.`);
        }

        // ── ISSUES ────────────────────────────────────────────────────────────
        case "list_issues": {
          const p: any = { owner, repo: a?.repo as string, state: (a?.state as any) ?? "open", per_page: (a?.per_page as number) ?? 20 };
          if (a?.label) p.labels = a.label;
          const { data } = await octokit.issues.listForRepo(p);
          const issues = data.filter(i => !i.pull_request);
          return ok(`Issues (${issues.length}):\n${issues.map(i => `#${i.number} [${i.state}] ${i.title}\n   @${i.user?.login} | Labels: ${i.labels.map((l: any) => l.name ?? l).join(", ") || "none"} | 💬${i.comments}`).join("\n\n") || "None."}`);
        }
        case "get_issue": {
          const { data: issue }    = await octokit.issues.get({ owner, repo: a?.repo as string, issue_number: a?.issue_number as number });
          const { data: comments } = await octokit.issues.listComments({ owner, repo: a?.repo as string, issue_number: a?.issue_number as number });
          return ok([`🐛 #${issue.number}: ${issue.title}`, `State: ${issue.state}  By: @${issue.user?.login}`, `Labels: ${issue.labels.map((l: any) => l.name ?? l).join(", ") || "none"}`, `URL: ${issue.html_url}`, "", issue.body ?? "(no description)", "", `Comments (${comments.length}):`, ...comments.map(c => `  @${c.user?.login}: ${c.body?.slice(0,200)}`)].join("\n"));
        }
        case "create_issue": {
          const { data: d } = await octokit.issues.create({ owner, repo: a?.repo as string, title: a?.title as string, body: (a?.body as string) ?? "", labels: (a?.labels as string[]) ?? [], assignees: (a?.assignees as string[]) ?? [] });
          return ok(`✅ Issue #${d.number} created!\n${d.html_url}`);
        }
        case "update_issue": {
          const p: any = { owner, repo: a?.repo as string, issue_number: a?.issue_number as number };
          if (a?.title)  p.title  = a.title;
          if (a?.body)   p.body   = a.body;
          if (a?.state)  p.state  = a.state;
          if (a?.labels) p.labels = a.labels;
          const { data: d } = await octokit.issues.update(p);
          return ok(`✅ Issue #${d.number} updated [${d.state}]\n${d.html_url}`);
        }
        case "comment_on_issue": {
          const { data: d } = await octokit.issues.createComment({ owner, repo: a?.repo as string, issue_number: a?.issue_number as number, body: a?.body as string });
          return ok(`✅ Comment posted!\n${d.html_url}`);
        }
        case "list_labels": {
          const { data } = await octokit.issues.listLabelsForRepo({ owner, repo: a?.repo as string, per_page: 100 });
          return ok(`Labels (${data.length}):\n${data.map(l => `  #${l.color}  ${l.name}`).join("\n")}`);
        }
        case "create_label": {
          const { data: d } = await octokit.issues.createLabel({ owner, repo: a?.repo as string, name: a?.name as string, color: a?.color as string, description: (a?.description as string) ?? "" });
          return ok(`✅ Label "${d.name}" created.`);
        }
        case "list_milestones": {
          const { data } = await octokit.issues.listMilestones({ owner, repo: a?.repo as string, state: (a?.state as any) ?? "open" });
          return ok(`Milestones:\n${data.map(m => `#${m.number} ${m.title} — ${m.open_issues} open | Due: ${m.due_on?.slice(0,10) ?? "none"}`).join("\n") || "None."}`);
        }
        case "create_milestone": {
          const { data: d } = await octokit.issues.createMilestone({ owner, repo: a?.repo as string, title: a?.title as string, description: (a?.description as string) ?? "", due_on: a?.due_on as string });
          return ok(`✅ Milestone #${d.number} "${d.title}" created.`);
        }

        // ── PULL REQUESTS ─────────────────────────────────────────────────────
        case "list_pull_requests": {
          const { data } = await octokit.pulls.list({ owner, repo: a?.repo as string, state: (a?.state as any) ?? "open" });
          return ok(`PRs (${data.length}):\n${data.map(pr => `#${pr.number} [${pr.state}] ${pr.title}\n   ${pr.head.ref} → ${pr.base.ref} | @${pr.user?.login}`).join("\n\n") || "None."}`);
        }
        case "get_pull_request": {
          const { data: d } = await octokit.pulls.get({ owner, repo: a?.repo as string, pull_number: a?.pull_number as number });
          return ok([`🔀 PR #${d.number}: ${d.title}`, `State  : ${d.state}${d.merged ? " (merged ✅)" : ""}`, `By     : @${d.user?.login}`, `Branches: ${d.head.ref} → ${d.base.ref}`, `Stats  : ${d.commits} commits | ${d.changed_files} files | +${d.additions} -${d.deletions}`, `URL    : ${d.html_url}`, "", d.body ?? "(no description)"].join("\n"));
        }
        case "create_pull_request": {
          const { data: d } = await octokit.pulls.create({ owner, repo: a?.repo as string, title: a?.title as string, head: a?.head as string, base: (a?.base as string) ?? "main", body: (a?.body as string) ?? "", draft: (a?.draft as boolean) ?? false });
          return ok(`✅ PR #${d.number} created!\n${d.html_url}`);
        }
        case "merge_pull_request": {
          if (!a?.confirmed) {
            const { data: pr } = await octokit.pulls.get({ owner, repo: a?.repo as string, pull_number: a?.pull_number as number });
            return ok(confirmBlock("MERGE PULL REQUEST", { Repo: `${owner}/${a?.repo}`, PR: `#${pr.number} — ${pr.title}`, From: pr.head.ref, Into: pr.base.ref, Method: (a?.merge_method as string) ?? "merge" }));
          }
          await octokit.pulls.merge({ owner, repo: a?.repo as string, pull_number: a?.pull_number as number, merge_method: (a?.merge_method as any) ?? "merge" });
          return ok(`✅ PR #${a?.pull_number} merged!`);
        }
        case "get_pr_diff": {
          const { data } = await octokit.pulls.listFiles({ owner, repo: a?.repo as string, pull_number: a?.pull_number as number });
          return ok(`Files in PR #${a?.pull_number} (${data.length}):\n${data.map(f => `${f.status.toUpperCase().padEnd(8)} ${f.filename}   +${f.additions} -${f.deletions}`).join("\n")}`);
        }
        case "request_pr_review": {
          await octokit.pulls.requestReviewers({ owner, repo: a?.repo as string, pull_number: a?.pull_number as number, reviewers: a?.reviewers as string[] });
          return ok(`✅ Review requested from: ${(a?.reviewers as string[]).map(r => `@${r}`).join(", ")}`);
        }
        case "list_pr_reviews": {
          const { data } = await octokit.pulls.listReviews({ owner, repo: a?.repo as string, pull_number: a?.pull_number as number });
          return ok(`Reviews (${data.length}):\n${data.map(r => `@${r.user?.login} [${r.state}] — ${r.body?.slice(0,150) || "(no comment)"}`).join("\n") || "None."}`);
        }

        // ── RELEASES ──────────────────────────────────────────────────────────
        case "list_releases": {
          const { data } = await octokit.repos.listReleases({ owner, repo: a?.repo as string, per_page: (a?.per_page as number) ?? 10 });
          return ok(`Releases (${data.length}):\n${data.map(r => `🏷️  ${r.tag_name} — ${r.name ?? ""} | ${r.published_at?.slice(0,10) ?? "draft"}\n   ${r.html_url}`).join("\n\n") || "None."}`);
        }
        case "get_latest_release": {
          const { data: d } = await octokit.repos.getLatestRelease({ owner, repo: a?.repo as string });
          return ok(`Latest: ${d.tag_name} — ${d.name}\n${d.body ?? "(no notes)"}\n${d.html_url}`);
        }
        case "create_release": {
          const { data: d } = await octokit.repos.createRelease({ owner, repo: a?.repo as string, tag_name: a?.tag_name as string, name: a?.name as string, body: (a?.body as string) ?? "", draft: (a?.draft as boolean) ?? false, prerelease: (a?.prerelease as boolean) ?? false, target_commitish: (a?.target_commitish as string) ?? "main" });
          return ok(`✅ Release ${d.tag_name} created!\n${d.html_url}`);
        }
        case "list_tags": {
          const { data } = await octokit.repos.listTags({ owner, repo: a?.repo as string, per_page: (a?.per_page as number) ?? 30 });
          return ok(`Tags (${data.length}):\n${data.map(t => `${t.name.padEnd(25)} ${t.commit.sha.slice(0,7)}`).join("\n") || "None."}`);
        }

        // ── ACTIONS ───────────────────────────────────────────────────────────
        case "list_workflows": {
          const { data } = await octokit.actions.listRepoWorkflows({ owner, repo: a?.repo as string });
          return ok(`Workflows (${data.total_count}):\n${data.workflows.map(w => `  ${w.name.padEnd(30)} ${w.path}  [${w.state}]`).join("\n") || "None."}`);
        }
        case "list_workflow_runs": {
          const p: any = { owner, repo: a?.repo as string, per_page: (a?.per_page as number) ?? 15 };
          if (a?.branch) p.branch = a.branch;
          if (a?.status) p.status = a.status;
          let runs: any[];
          if (a?.workflow_id) { const r = await octokit.actions.listWorkflowRuns({ ...p, workflow_id: a.workflow_id as any }); runs = r.data.workflow_runs; }
          else { const r = await octokit.actions.listWorkflowRunsForRepo(p); runs = r.data.workflow_runs; }
          return ok(`Runs (${runs.length}):\n${runs.map(r => `#${r.id} ${r.name} [${r.status}/${r.conclusion ?? "…"}] ${r.head_branch} | ${r.created_at.slice(0,10)}`).join("\n")}`);
        }
        case "get_workflow_run": {
          const { data: d }    = await octokit.actions.getWorkflowRun({ owner, repo: a?.repo as string, run_id: a?.run_id as number });
          const { data: jobs } = await octokit.actions.listJobsForWorkflowRun({ owner, repo: a?.repo as string, run_id: a?.run_id as number });
          return ok([`⚙️  Run #${d.id}: ${d.name}`, `Status : ${d.status}/${d.conclusion ?? "running"}`, `Branch : ${d.head_branch} | Commit: ${d.head_sha.slice(0,7)}`, `URL    : ${d.html_url}`, "", "Jobs:", ...jobs.jobs.map(j => `  ${j.name.padEnd(35)} [${j.status}/${j.conclusion ?? "…"}]`)].join("\n"));
        }
        case "rerun_workflow": {
          await octokit.actions.reRunWorkflow({ owner, repo: a?.repo as string, run_id: a?.run_id as number });
          return ok(`🔁 Run #${a?.run_id} re-triggered.`);
        }
        case "cancel_workflow_run": {
          if (!a?.confirmed) return ok(confirmBlock("CANCEL WORKFLOW RUN", { Repo: `${owner}/${a?.repo}`, RunID: String(a?.run_id) }));
          await octokit.actions.cancelWorkflowRun({ owner, repo: a?.repo as string, run_id: a?.run_id as number });
          return ok(`🛑 Run #${a?.run_id} cancelled.`);
        }
        case "trigger_workflow": {
          await octokit.actions.createWorkflowDispatch({ owner, repo: a?.repo as string, workflow_id: a?.workflow_id as string, ref: (a?.ref as string) ?? "main", inputs: (a?.inputs as any) ?? {} });
          return ok(`🚀 Workflow '${a?.workflow_id}' triggered on '${a?.ref ?? "main"}'.`);
        }

        // ── STATS & PROFILE ───────────────────────────────────────────────────
        case "get_repo_stats": {
          const [langRes, contribRes, repoRes] = await Promise.all([octokit.repos.listLanguages({ owner, repo: a?.repo as string }), octokit.repos.getContributorsStats({ owner, repo: a?.repo as string }), octokit.repos.get({ owner, repo: a?.repo as string })]);
          const total = Object.values(langRes.data).reduce((s: number, b) => s + (b as number), 0);
          const langs = Object.entries(langRes.data).sort(([,a],[,b]) => (b as number)-(a as number)).map(([l, b]) => `  ${l}: ${(((b as number)/total)*100).toFixed(1)}%`).join("\n");
          const contribs = Array.isArray(contribRes.data) ? contribRes.data.sort((a,b) => (b.total??0)-(a.total??0)).slice(0,8).map(c => `  @${(c.author?.login??"?").padEnd(20)} ${c.total} commits`).join("\n") : "  Still computing...";
          return ok([`📊 ${owner}/${a?.repo}`, `⭐${repoRes.data.stargazers_count} 🍴${repoRes.data.forks_count} 🐛${repoRes.data.open_issues_count}`, "", "Languages:", langs, "", "Top contributors:", contribs].join("\n"));
        }
        case "get_repo_traffic": {
          const [v, c] = await Promise.all([octokit.repos.getViews({ owner, repo: a?.repo as string }), octokit.repos.getClones({ owner, repo: a?.repo as string })]);
          return ok(`Traffic for ${owner}/${a?.repo}\nViews: ${v.data.count} (${v.data.uniques} unique)\nClones: ${c.data.count} (${c.data.uniques} unique)`);
        }
        case "get_my_activity": {
          const { data } = await octokit.activity.listEventsForAuthenticatedUser({ username: USERNAME, per_page: (a?.per_page as number) ?? 20 });
          return ok(`Activity for @${USERNAME}:\n${data.map(e => `${e.created_at?.slice(0,10)} | ${(e.type?.replace("Event","") ?? "?").padEnd(14)} | ${(e.repo as any)?.name ?? "?"}`).join("\n")}`);
        }
        case "get_my_profile": {
          const { data: d } = await octokit.users.getAuthenticated();
          return ok([`👤 @${d.login}`, `Name    : ${d.name ?? "not set"}`, `Bio     : ${d.bio ?? "not set"}`, `Location: ${d.location ?? "not set"}`, `Repos   : ${d.public_repos} public`, `Followers: ${d.followers}  Following: ${d.following}`, `Joined  : ${d.created_at.slice(0,10)}`, d.html_url].join("\n"));
        }
        case "list_notifications": {
          const { data } = await octokit.activity.listNotificationsForAuthenticatedUser({ all: (a?.all as boolean) ?? false, per_page: (a?.per_page as number) ?? 20 });
          if (!data.length) return ok("🎉 No unread notifications!");
          return ok(`Notifications (${data.length}):\n${data.map(n => `[${n.reason}] ${n.subject.title}\n   ${n.repository.full_name}`).join("\n\n")}`);
        }
        case "star_repo":   { await octokit.activity.starRepoForAuthenticatedUser({ owner: a?.owner as string, repo: a?.repo as string });   return ok(`⭐ Starred ${a?.owner}/${a?.repo}`); }
        case "unstar_repo": { await octokit.activity.unstarRepoForAuthenticatedUser({ owner: a?.owner as string, repo: a?.repo as string }); return ok(`Unstarred ${a?.owner}/${a?.repo}`); }
        case "list_starred_repos": {
          const { data } = await octokit.activity.listReposStarredByAuthenticatedUser({ per_page: (a?.per_page as number) ?? 30 });
          return ok(`Starred (${data.length}):\n${(data as any[]).map((r: any) => `⭐ ${r.full_name} — ${r.description ?? ""}`).join("\n")}`);
        }

        // ── SEARCH ────────────────────────────────────────────────────────────
        case "search_code": {
          let q = a?.query as string;
          if (a?.repo) q += ` repo:${a.repo}`;
          if (a?.language) q += ` language:${a.language}`;
          const { data } = await octokit.search.code({ q, per_page: (a?.per_page as number) ?? 10 });
          return ok(`Code (${data.total_count} total):\n${data.items.map(i => `📄 ${i.repository.full_name} — ${i.path}\n   ${i.html_url}`).join("\n\n")}`);
        }
        case "search_issues": {
          const { data } = await octokit.search.issuesAndPullRequests({ q: a?.query as string, per_page: (a?.per_page as number) ?? 10 });
          return ok(`Results (${data.total_count}):\n${data.items.map(i => `${i.pull_request ? "🔀 PR" : "🐛 Issue"} #${i.number} [${i.state}] ${i.title}\n   ${i.html_url}`).join("\n\n")}`);
        }
        case "search_commits": {
          let q = a?.query as string;
          if (a?.repo) q += ` repo:${a.repo}`;
          const { data } = await octokit.search.commits({ q, per_page: (a?.per_page as number) ?? 10 });
          return ok(`Commits (${data.total_count}):\n${data.items.map(c => `${c.sha.slice(0,7)} ${c.commit.message.split("\n")[0]}\n   ${(c.repository as any).full_name}`).join("\n\n")}`);
        }

        // ── ADMIN ─────────────────────────────────────────────────────────────
        case "list_collaborators": {
          const { data } = await octokit.repos.listCollaborators({ owner, repo: a?.repo as string });
          return ok(`Collaborators (${data.length}):\n${data.map(u => `@${u.login.padEnd(25)} ${u.permissions ? Object.entries(u.permissions).filter(([,v])=>v).map(([k])=>k).join(", ") : "?"}`).join("\n")}`);
        }
        case "add_collaborator": {
          await octokit.repos.addCollaborator({ owner, repo: a?.repo as string, username: a?.username as string, permission: (a?.permission as any) ?? "push" });
          return ok(`✅ @${a?.username} added as collaborator (${a?.permission ?? "push"}).`);
        }
        case "remove_collaborator": {
          if (!a?.confirmed) return ok(confirmBlock("REMOVE COLLABORATOR", { Repo: `${owner}/${a?.repo}`, User: `@${a?.username}` }));
          await octokit.repos.removeCollaborator({ owner, repo: a?.repo as string, username: a?.username as string });
          return ok(`🗑️  @${a?.username} removed.`);
        }
        case "list_deploy_keys": {
          const { data } = await octokit.repos.listDeployKeys({ owner, repo: a?.repo as string });
          return ok(`Deploy keys (${data.length}):\n${data.map(k => `${k.id} | ${k.title} | ${k.read_only ? "read-only" : "read-write"}`).join("\n") || "None."}`);
        }

        default:
          return { content: [{ type: "text" as const, text: `❌ Unknown tool: ${name}` }], isError: true as const };
      }
    } catch (e: any) {
      return githubErr(e);
    }
}

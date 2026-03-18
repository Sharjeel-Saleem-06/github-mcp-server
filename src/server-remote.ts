#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  GitHub MCP Server — Remote / HTTP Mode                     ║
 * ║  Secured with Bearer token authentication.                  ║
 * ║  Deploy to Railway: railway.app                             ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   In claude_desktop_config.json (or any MCP client):
 *   {
 *     "url": "https://your-app.up.railway.app/sse",
 *     "headers": { "Authorization": "Bearer YOUR_MCP_SECRET_KEY" }
 *   }
 */

import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "@octokit/rest";
import * as dotenv from "dotenv";
import { toolDefinitions } from "./tools/definitions.js";
import { confirmationBlock, ok, githubError, defaultBranch } from "./tools/helpers.js";

// Silence dotenv stdout (same fix as local mode)
const _w = process.stdout.write.bind(process.stdout);
(process.stdout.write as any) = () => true;
dotenv.config();
(process.stdout.write as any) = _w;

// ─── Validate config ──────────────────────────────────────────────────────────
const GITHUB_TOKEN    = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const MCP_SECRET_KEY  = process.env.MCP_SECRET_KEY;
const PORT            = parseInt(process.env.PORT ?? "3000", 10);

if (!GITHUB_TOKEN)    { console.error("❌ GITHUB_TOKEN missing");    process.exit(1); }
if (!GITHUB_USERNAME) { console.error("❌ GITHUB_USERNAME missing"); process.exit(1); }
if (!MCP_SECRET_KEY)  { console.error("❌ MCP_SECRET_KEY missing — set a strong random secret"); process.exit(1); }

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: "*",  // Claude Desktop origin varies; the Bearer token IS the security
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "X-Accel-Buffering"],
}));

app.use(express.json());

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers["authorization"];
  if (!authHeader || authHeader !== `Bearer ${MCP_SECRET_KEY}`) {
    res.status(401).json({
      error: "Unauthorized",
      hint: "Include: Authorization: Bearer <your MCP_SECRET_KEY>"
    });
    return;
  }
  next();
}

// ─── Health check (public — safe to expose) ───────────────────────────────────
app.get("/", (_req, res) => {
  res.json({ status: "ok", name: "github-mcp-server", version: "3.0.0" });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ─── Session store ────────────────────────────────────────────────────────────
const sessions = new Map<string, SSEServerTransport>();

// ─── SSE endpoint — Claude connects here ──────────────────────────────────────
app.get("/sse", requireAuth, async (req: Request, res: Response) => {
  console.log("New MCP connection");

  // One MCP server instance per SSE connection
  const mcpServer = buildMCPServer();
  const transport = new SSEServerTransport("/messages", res);

  sessions.set(transport.sessionId, transport);

  transport.onclose = () => {
    sessions.delete(transport.sessionId);
    console.log(`Session ${transport.sessionId} closed`);
  };

  await mcpServer.connect(transport);
});

// ─── Messages endpoint — Claude sends tool calls here ─────────────────────────
app.post("/messages", requireAuth, async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = sessions.get(sessionId);

  if (!transport) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }

  await transport.handlePostMessage(req, res);
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ GitHub MCP Remote Server on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   MCP:    http://localhost:${PORT}/sse  (requires Bearer token)`);
});

// ─── MCP Server Builder ───────────────────────────────────────────────────────
function buildMCPServer(): Server {
  const server = new Server(
    { name: "github-mcp-server", version: "3.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions as unknown as any[]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: a } = request.params;
    const owner = (a?.owner as string) || GITHUB_USERNAME!;

    try {
      switch (name) {

        case "list_repos": {
          const { data } = await octokit.repos.listForAuthenticatedUser({ sort: "updated", per_page: (a?.per_page as number) ?? 30, type: (a?.type as any) ?? "all" });
          return ok(data.map(r => `📁 ${r.full_name} [${r.private ? "🔒" : "🌍"}] ${r.language ?? ""}\n   ⭐${r.stargazers_count} — ${r.description ?? "no description"}\n   ${r.html_url}`).join("\n\n"));
        }

        case "get_repo": {
          const { data: d } = await octokit.repos.get({ owner, repo: a?.repo as string });
          return ok([`📦 ${d.full_name}`, `Description : ${d.description ?? "none"}`, `Visibility  : ${d.private ? "🔒 private" : "🌍 public"}`, `Language    : ${d.language ?? "unknown"}`, `Default br  : ${d.default_branch}`, `Stars       : ⭐${d.stargazers_count}  Forks: 🍴${d.forks_count}`, `Open issues : ${d.open_issues_count}`, `Created     : ${d.created_at?.slice(0,10)}`, `Last push   : ${d.pushed_at?.slice(0,10)}`, `URL         : ${d.html_url}`].join("\n"));
        }

        case "create_repo": {
          const { data: d } = await octokit.repos.createForAuthenticatedUser({ name: a?.name as string, description: (a?.description as string) ?? "", private: (a?.private as boolean) ?? false, auto_init: (a?.auto_init as boolean) ?? true });
          return ok(`✅ Repository created!\nName : ${d.full_name}\nURL  : ${d.html_url}\nClone: ${d.clone_url}`);
        }

        case "delete_repo": {
          if (!a?.confirmed) return ok(confirmationBlock("DELETE REPOSITORY", { Repo: `${owner}/${a?.repo}`, WARNING: "PERMANENT — deletes everything" }));
          await octokit.repos.delete({ owner, repo: a?.repo as string });
          return ok(`🗑️  ${owner}/${a?.repo} deleted.`);
        }

        case "search_repos": {
          const { data } = await octokit.search.repos({ q: a?.query as string, per_page: (a?.per_page as number) ?? 10 });
          return ok(data.items.map(r => `📁 ${r.full_name} ⭐${r.stargazers_count}\n   ${r.description ?? ""}\n   ${r.html_url}`).join("\n\n"));
        }

        case "get_repo_topics": {
          const { data } = await octokit.repos.getAllTopics({ owner, repo: a?.repo as string });
          return ok(`Topics: ${data.names.join(", ") || "(none)"}`);
        }

        case "set_repo_topics": {
          await octokit.repos.replaceAllTopics({ owner, repo: a?.repo as string, names: a?.topics as string[] });
          return ok(`✅ Topics updated: ${(a?.topics as string[]).join(", ")}`);
        }

        case "fork_repo": {
          const { data: d } = await octokit.repos.createFork({ owner: a?.owner as string, repo: a?.repo as string });
          return ok(`✅ Forked! ${d.full_name}\n${d.html_url}`);
        }

        case "get_repo_traffic": {
          const [v, c] = await Promise.all([octokit.repos.getViews({ owner, repo: a?.repo as string }), octokit.repos.getClones({ owner, repo: a?.repo as string })]);
          return ok(`Traffic for ${owner}/${a?.repo}\nViews : ${v.data.count} (${v.data.uniques} unique)\nClones: ${c.data.count} (${c.data.uniques} unique)`);
        }

        case "update_repo_settings": {
          const p: any = { owner, repo: a?.repo as string };
          if (a?.description !== undefined) p.description = a.description;
          if (a?.homepage    !== undefined) p.homepage    = a.homepage;
          if (a?.private     !== undefined) p.private     = a.private;
          if (a?.has_issues  !== undefined) p.has_issues  = a.has_issues;
          const { data: d } = await octokit.repos.update(p);
          return ok(`✅ Settings updated: ${d.full_name}`);
        }

        case "list_branches": {
          const { data } = await octokit.repos.listBranches({ owner, repo: a?.repo as string, per_page: 100 });
          return ok(`Branches (${data.length}):\n${data.map((b, i) => `${i+1}. ${b.name.padEnd(30)} ${b.commit.sha.slice(0,7)} ${b.protected ? "🔒" : ""}`).join("\n")}`);
        }

        case "get_branch": {
          const { data: d } = await octokit.repos.getBranch({ owner, repo: a?.repo as string, branch: a?.branch as string });
          return ok(`🌿 ${d.name}\nSHA: ${d.commit.sha}\nProtected: ${d.protected ? "Yes 🔒" : "No"}`);
        }

        case "create_branch": {
          const db = await defaultBranch(octokit, owner, a?.repo as string);
          const from = (a?.from_branch as string) ?? db;
          const { data: ref } = await octokit.git.getRef({ owner, repo: a?.repo as string, ref: `heads/${from}` });
          await octokit.git.createRef({ owner, repo: a?.repo as string, ref: `refs/heads/${a?.new_branch}`, sha: ref.object.sha });
          return ok(`✅ Branch '${a?.new_branch}' created from '${from}'`);
        }

        case "delete_branch": {
          if (!a?.confirmed) return ok(confirmationBlock("DELETE BRANCH", { Repo: `${owner}/${a?.repo}`, Branch: a?.branch as string, WARNING: "Unmerged commits will be lost" }));
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
          } catch { return ok(`No protection rules on '${a?.branch}'`); }
        }

        case "list_commits": {
          const db = await defaultBranch(octokit, owner, a?.repo as string);
          const p: any = { owner, repo: a?.repo as string, sha: (a?.branch as string) ?? db, per_page: (a?.per_page as number) ?? 15 };
          if (a?.since) p.since = new Date(a.since as string).toISOString();
          if (a?.author) p.author = a.author;
          const { data } = await octokit.repos.listCommits(p);
          return ok(`Commits on '${p.sha}' (${data.length}):\n${data.map((c,i) => `${i+1}. ${c.sha.slice(0,7)} | ${c.commit.author?.date?.slice(0,10)} | ${(c.commit.author?.name ?? "?").padEnd(18)} | ${c.commit.message.split("\n")[0]}`).join("\n")}`);
        }

        case "get_commit_diff": {
          const { data: d } = await octokit.repos.getCommit({ owner, repo: a?.repo as string, ref: a?.commit_sha as string });
          return ok([`📝 ${d.sha.slice(0,7)}`, `Author : ${d.commit.author?.name}`, `Date   : ${d.commit.author?.date?.slice(0,10)}`, `Message: ${d.commit.message}`, "", "Files:", ...(d.files ?? []).map(f => `  ${f.status.toUpperCase().padEnd(8)} ${f.filename}  +${f.additions} -${f.deletions}`), ``, `Total: +${d.stats?.additions} -${d.stats?.deletions}`].join("\n"));
        }

        case "compare_branches": {
          const { data: d } = await octokit.repos.compareCommitsWithBasehead({ owner, repo: a?.repo as string, basehead: `${a?.base}...${a?.head}` });
          return ok([`📊 '${a?.base}' vs '${a?.head}'`, `Ahead: ${d.ahead_by} | Behind: ${d.behind_by} | Files changed: ${d.files?.length ?? 0}`, "", `Commits in '${a?.head}':`, ...d.commits.map(c => `  ${c.sha.slice(0,7)} ${c.commit.message.split("\n")[0]}`)].join("\n"));
        }

        case "get_commit_history": {
          const db = await defaultBranch(octokit, owner, a?.repo as string);
          const branch = (a?.branch as string) ?? db;
          const { data } = await octokit.repos.listCommits({ owner, repo: a?.repo as string, sha: branch, per_page: (a?.per_page as number) ?? 20 });
          return ok(`📜 History on '${branch}':\n${"─".repeat(80)}\n${data.map(c => `${c.sha.slice(0,7)}  ${c.commit.author?.date?.slice(0,10)}  ${(c.commit.author?.name ?? "?").slice(0,18).padEnd(20)}  ${c.commit.message.split("\n")[0].slice(0,50)}`).join("\n")}`);
        }

        case "get_file_contents": {
          const db = await defaultBranch(octokit, owner, a?.repo as string);
          const { data: d } = await octokit.repos.getContent({ owner, repo: a?.repo as string, path: a?.path as string, ref: (a?.branch as string) ?? db });
          if ("content" in d && !Array.isArray(d)) return ok(`📄 ${d.path} (${d.size} bytes)\n\n${Buffer.from(d.content, "base64").toString("utf-8")}`);
          return ok("That path is a directory.");
        }

        case "list_directory": {
          const db = await defaultBranch(octokit, owner, a?.repo as string);
          const { data: d } = await octokit.repos.getContent({ owner, repo: a?.repo as string, path: (a?.path as string) ?? "", ref: (a?.branch as string) ?? db });
          if (Array.isArray(d)) return ok(d.map(i => `${i.type === "dir" ? "📁" : "📄"} ${i.name.padEnd(38)} ${i.type === "file" ? `${i.size}b` : ""}`).join("\n"));
          return ok("That path is a file. Use get_file_contents.");
        }

        case "create_or_update_file": {
          if (!a?.confirmed) return ok(confirmationBlock("CREATE/UPDATE FILE", { Repo: `${owner}/${a?.repo}`, File: a?.path as string, Commit: a?.message as string }));
          const db = await defaultBranch(octokit, owner, a?.repo as string);
          const branch = (a?.branch as string) ?? db;
          const content = Buffer.from(a?.content as string).toString("base64");
          let sha: string | undefined;
          try { const { data: ex } = await octokit.repos.getContent({ owner, repo: a?.repo as string, path: a?.path as string, ref: branch }); if (!Array.isArray(ex) && "sha" in ex) sha = ex.sha; } catch {}
          const { data: d } = await octokit.repos.createOrUpdateFileContents({ owner, repo: a?.repo as string, path: a?.path as string, message: a?.message as string, content, branch, sha });
          return ok(`✅ File ${sha ? "updated" : "created"}! Commit: ${d.commit.sha?.slice(0,7)}\n${d.content?.html_url}`);
        }

        case "delete_file": {
          if (!a?.confirmed) return ok(confirmationBlock("DELETE FILE", { Repo: `${owner}/${a?.repo}`, File: a?.path as string }));
          const db = await defaultBranch(octokit, owner, a?.repo as string);
          const branch = (a?.branch as string) ?? db;
          const { data: ex } = await octokit.repos.getContent({ owner, repo: a?.repo as string, path: a?.path as string, ref: branch });
          if (Array.isArray(ex) || !("sha" in ex)) return ok("That path is a directory, not a file.");
          await octokit.repos.deleteFile({ owner, repo: a?.repo as string, path: a?.path as string, message: a?.message as string, sha: ex.sha, branch });
          return ok(`🗑️  '${a?.path}' deleted.`);
        }

        case "list_issues": {
          const p: any = { owner, repo: a?.repo as string, state: (a?.state as any) ?? "open", per_page: (a?.per_page as number) ?? 20 };
          if (a?.label) p.labels = a.label;
          const { data } = await octokit.issues.listForRepo(p);
          const issues = data.filter(i => !i.pull_request);
          return ok(`Issues (${issues.length}):\n${issues.map(i => `#${i.number} [${i.state}] ${i.title}\n   @${i.user?.login} | Labels: ${i.labels.map((l: any) => l.name ?? l).join(", ") || "none"}`).join("\n\n") || "None."}`);
        }

        case "get_issue": {
          const { data: issue } = await octokit.issues.get({ owner, repo: a?.repo as string, issue_number: a?.issue_number as number });
          const { data: comments } = await octokit.issues.listComments({ owner, repo: a?.repo as string, issue_number: a?.issue_number as number });
          return ok([`🐛 #${issue.number}: ${issue.title}`, `State: ${issue.state}  By: @${issue.user?.login}`, `Labels: ${issue.labels.map((l: any) => l.name ?? l).join(", ") || "none"}`, `Created: ${issue.created_at.slice(0,10)}  URL: ${issue.html_url}`, "", issue.body ?? "(no description)", "", `Comments (${comments.length}):`, ...comments.map(c => `  @${c.user?.login}: ${c.body?.slice(0,200)}`)].join("\n"));
        }

        case "create_issue": {
          const { data: d } = await octokit.issues.create({ owner, repo: a?.repo as string, title: a?.title as string, body: (a?.body as string) ?? "", labels: (a?.labels as string[]) ?? [], assignees: (a?.assignees as string[]) ?? [] });
          return ok(`✅ Issue #${d.number} created: ${d.html_url}`);
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
          return ok(`✅ Comment posted: ${d.html_url}`);
        }

        case "list_labels": {
          const { data } = await octokit.issues.listLabelsForRepo({ owner, repo: a?.repo as string, per_page: 100 });
          return ok(`Labels (${data.length}):\n${data.map(l => `  #${l.color}  ${l.name}`).join("\n")}`);
        }

        case "create_label": {
          const { data: d } = await octokit.issues.createLabel({ owner, repo: a?.repo as string, name: a?.name as string, color: a?.color as string, description: (a?.description as string) ?? "" });
          return ok(`✅ Label "${d.name}" (#${d.color}) created.`);
        }

        case "list_milestones": {
          const { data } = await octokit.issues.listMilestones({ owner, repo: a?.repo as string, state: (a?.state as any) ?? "open" });
          return ok(`Milestones:\n${data.map(m => `#${m.number} ${m.title} — ${m.open_issues} open | Due: ${m.due_on?.slice(0,10) ?? "none"}`).join("\n") || "None."}`);
        }

        case "create_milestone": {
          const { data: d } = await octokit.issues.createMilestone({ owner, repo: a?.repo as string, title: a?.title as string, description: (a?.description as string) ?? "", due_on: a?.due_on as string });
          return ok(`✅ Milestone #${d.number} "${d.title}" created.`);
        }

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
          return ok(`✅ PR #${d.number} created: ${d.html_url}`);
        }

        case "merge_pull_request": {
          if (!a?.confirmed) {
            const { data: pr } = await octokit.pulls.get({ owner, repo: a?.repo as string, pull_number: a?.pull_number as number });
            return ok(confirmationBlock("MERGE PULL REQUEST", { Repo: `${owner}/${a?.repo}`, PR: `#${pr.number} — ${pr.title}`, From: pr.head.ref, Into: pr.base.ref, Method: (a?.merge_method as string) ?? "merge" }));
          }
          await octokit.pulls.merge({ owner, repo: a?.repo as string, pull_number: a?.pull_number as number, merge_method: (a?.merge_method as any) ?? "merge" });
          return ok(`✅ PR #${a?.pull_number} merged!`);
        }

        case "get_pr_diff": {
          const { data } = await octokit.pulls.listFiles({ owner, repo: a?.repo as string, pull_number: a?.pull_number as number });
          return ok(`Files in PR #${a?.pull_number} (${data.length}):\n${data.map(f => `${f.status.toUpperCase().padEnd(8)} ${f.filename}  +${f.additions} -${f.deletions}`).join("\n")}`);
        }

        case "request_pr_review": {
          await octokit.pulls.requestReviewers({ owner, repo: a?.repo as string, pull_number: a?.pull_number as number, reviewers: a?.reviewers as string[] });
          return ok(`✅ Review requested from: ${(a?.reviewers as string[]).map(r => `@${r}`).join(", ")}`);
        }

        case "list_pr_reviews": {
          const { data } = await octokit.pulls.listReviews({ owner, repo: a?.repo as string, pull_number: a?.pull_number as number });
          return ok(`Reviews (${data.length}):\n${data.map(r => `@${r.user?.login} [${r.state}] ${r.body?.slice(0,150) || "(no comment)"}`).join("\n") || "None."}`);
        }

        case "list_releases": {
          const { data } = await octokit.repos.listReleases({ owner, repo: a?.repo as string, per_page: (a?.per_page as number) ?? 10 });
          return ok(`Releases (${data.length}):\n${data.map(r => `🏷️  ${r.tag_name} — ${r.name ?? "untitled"} | ${r.published_at?.slice(0,10) ?? "draft"}\n   ${r.html_url}`).join("\n\n") || "None."}`);
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

        case "list_workflows": {
          const { data } = await octokit.actions.listRepoWorkflows({ owner, repo: a?.repo as string });
          return ok(`Workflows (${data.total_count}):\n${data.workflows.map(w => `  ${w.name.padEnd(30)} ${w.path} [${w.state}]`).join("\n") || "None."}`);
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
          const { data: d } = await octokit.actions.getWorkflowRun({ owner, repo: a?.repo as string, run_id: a?.run_id as number });
          const { data: jobs } = await octokit.actions.listJobsForWorkflowRun({ owner, repo: a?.repo as string, run_id: a?.run_id as number });
          return ok([`⚙️  Run #${d.id}: ${d.name}`, `Status : ${d.status}/${d.conclusion ?? "running"}`, `Branch : ${d.head_branch} | Commit: ${d.head_sha.slice(0,7)}`, `URL    : ${d.html_url}`, "", "Jobs:", ...jobs.jobs.map(j => `  ${j.name.padEnd(35)} [${j.status}/${j.conclusion ?? "…"}]`)].join("\n"));
        }

        case "rerun_workflow": {
          await octokit.actions.reRunWorkflow({ owner, repo: a?.repo as string, run_id: a?.run_id as number });
          return ok(`🔁 Workflow run #${a?.run_id} re-triggered.`);
        }

        case "cancel_workflow_run": {
          if (!a?.confirmed) return ok(confirmationBlock("CANCEL WORKFLOW RUN", { Repo: `${owner}/${a?.repo}`, RunID: String(a?.run_id) }));
          await octokit.actions.cancelWorkflowRun({ owner, repo: a?.repo as string, run_id: a?.run_id as number });
          return ok(`🛑 Run #${a?.run_id} cancelled.`);
        }

        case "trigger_workflow": {
          await octokit.actions.createWorkflowDispatch({ owner, repo: a?.repo as string, workflow_id: a?.workflow_id as string, ref: (a?.ref as string) ?? "main", inputs: (a?.inputs as any) ?? {} });
          return ok(`🚀 Workflow '${a?.workflow_id}' triggered on '${a?.ref ?? "main"}'.`);
        }

        case "get_repo_stats": {
          const [langRes, contribRes, repoRes] = await Promise.all([octokit.repos.listLanguages({ owner, repo: a?.repo as string }), octokit.repos.getContributorsStats({ owner, repo: a?.repo as string }), octokit.repos.get({ owner, repo: a?.repo as string })]);
          const total = Object.values(langRes.data).reduce((s: number, b) => s + (b as number), 0);
          const langs = Object.entries(langRes.data).sort(([,a],[,b]) => (b as number)-(a as number)).map(([l, b]) => `  ${l}: ${(((b as number)/total)*100).toFixed(1)}%`).join("\n");
          const contribs = Array.isArray(contribRes.data) ? contribRes.data.sort((a,b) => (b.total??0)-(a.total??0)).slice(0,8).map(c => `  @${(c.author?.login??"?").padEnd(20)} ${c.total} commits`).join("\n") : "  Still computing...";
          return ok([`📊 ${owner}/${a?.repo}`, `⭐${repoRes.data.stargazers_count} 🍴${repoRes.data.forks_count} 🐛${repoRes.data.open_issues_count}`, "", "Languages:", langs, "", "Contributors:", contribs].join("\n"));
        }

        case "get_repo_traffic": {
          const [v, c] = await Promise.all([octokit.repos.getViews({ owner, repo: a?.repo as string }), octokit.repos.getClones({ owner, repo: a?.repo as string })]);
          return ok(`Traffic for ${owner}/${a?.repo}\nViews: ${v.data.count} (${v.data.uniques} unique)\nClones: ${c.data.count} (${c.data.uniques} unique)\n\nRecent views:\n${v.data.views.slice(-7).map(x => `  ${x.timestamp.slice(0,10)}: ${x.count}`).join("\n")}`);
        }

        case "get_my_activity": {
          const { data } = await octokit.activity.listEventsForAuthenticatedUser({ username: GITHUB_USERNAME!, per_page: (a?.per_page as number) ?? 20 });
          return ok(`Activity for @${GITHUB_USERNAME}:\n${data.map(e => `${e.created_at?.slice(0,10)} | ${(e.type?.replace("Event","") ?? "?").padEnd(14)} | ${(e.repo as any)?.name ?? "?"}`).join("\n")}`);
        }

        case "get_my_profile": {
          const { data: d } = await octokit.users.getAuthenticated();
          return ok([`👤 @${d.login}`, `Name    : ${d.name ?? "not set"}`, `Bio     : ${d.bio ?? "not set"}`, `Location: ${d.location ?? "not set"}`, `Repos   : ${d.public_repos} public / ${d.total_private_repos ?? 0} private`, `Followers: ${d.followers}  Following: ${d.following}`, `Joined  : ${d.created_at.slice(0,10)}`, d.html_url].join("\n"));
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

        case "list_collaborators": {
          const { data } = await octokit.repos.listCollaborators({ owner, repo: a?.repo as string });
          return ok(`Collaborators (${data.length}):\n${data.map(u => `@${u.login.padEnd(25)} ${u.permissions ? Object.entries(u.permissions).filter(([,v])=>v).map(([k])=>k).join(", ") : "?"}`).join("\n")}`);
        }

        case "add_collaborator": {
          await octokit.repos.addCollaborator({ owner, repo: a?.repo as string, username: a?.username as string, permission: (a?.permission as any) ?? "push" });
          return ok(`✅ @${a?.username} added as collaborator.`);
        }

        case "remove_collaborator": {
          if (!a?.confirmed) return ok(confirmationBlock("REMOVE COLLABORATOR", { Repo: `${owner}/${a?.repo}`, User: `@${a?.username}` }));
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
      return githubError(e);
    }
  });

  return server;
}

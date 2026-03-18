import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "@octokit/rest";
import * as dotenv from "dotenv";
import { toolDefinitions } from "./tools/definitions.js";
import { confirmationBlock, ok, githubError, defaultBranch } from "./tools/helpers.js";

// ─── CRITICAL: Silence stdout during dotenv load ───────────────────────────────
// MCP communicates over stdio (stdout). If ANYTHING is printed to stdout that
// isn't valid JSON-RPC, Claude Desktop throws "Unexpected token" and disconnects.
// dotenv v17 prints a tip message to stdout — we must suppress it.
const _origWrite = process.stdout.write.bind(process.stdout);
(process.stdout.write as any) = () => true;   // swallow all stdout temporarily
dotenv.config();
(process.stdout.write as any) = _origWrite;    // restore stdout — MCP can now use it

const GITHUB_TOKEN    = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;

if (!GITHUB_TOKEN || GITHUB_TOKEN.includes("YOUR_TOKEN")) {
  console.error("❌  GITHUB_TOKEN missing in .env"); process.exit(1);
}
if (!GITHUB_USERNAME) {
  console.error("❌  GITHUB_USERNAME missing in .env"); process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const server = new Server(
  { name: "github-mcp-server", version: "3.0.0" },
  { capabilities: { tools: {} } }
);

// ─── LIST TOOLS ───────────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions as unknown as any[]
}));

// ─── HANDLERS ─────────────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: a } = request.params;

  // Resolve owner: use provided arg or fall back to authenticated user
  const owner = (a?.owner as string) || GITHUB_USERNAME!;

  try {
    switch (name) {

      // ══ REPOSITORIES ═══════════════════════════════════════════════════════

      case "list_repos": {
        const { data } = await octokit.repos.listForAuthenticatedUser({
          sort: "updated", per_page: (a?.per_page as number) ?? 30,
          type: (a?.type as any) ?? "all"
        });
        const lines = data.map(r =>
          `📁 ${r.full_name} [${r.private ? "🔒" : "🌍"}] ${r.language ?? ""}\n   ⭐${r.stargazers_count} 🍴${r.forks_count} — ${r.description ?? "no description"}\n   ${r.html_url}`
        );
        return ok(`${data.length} repositories:\n\n${lines.join("\n\n")}`);
      }

      case "get_repo": {
        const { data: d } = await octokit.repos.get({ owner, repo: a?.repo as string });
        return ok([
          `📦 ${d.full_name}`,
          `Description : ${d.description ?? "none"}`,
          `Visibility  : ${d.private ? "🔒 private" : "🌍 public"}`,
          `Language    : ${d.language ?? "unknown"}`,
          `Default br  : ${d.default_branch}`,
          `Stars       : ⭐ ${d.stargazers_count}  Forks: 🍴 ${d.forks_count}`,
          `Open issues : ${d.open_issues_count}`,
          `Size        : ${d.size} KB`,
          `Created     : ${d.created_at?.slice(0,10)}`,
          `Last push   : ${d.pushed_at?.slice(0,10)}`,
          `Clone URL   : ${d.clone_url}`,
          `URL         : ${d.html_url}`,
        ].join("\n"));
      }

      case "create_repo": {
        const { data: d } = await octokit.repos.createForAuthenticatedUser({
          name: a?.name as string,
          description: (a?.description as string) ?? "",
          private: (a?.private as boolean) ?? false,
          auto_init: (a?.auto_init as boolean) ?? true,
        });
        return ok(`✅ Repository created!\nName  : ${d.full_name}\nURL   : ${d.html_url}\nClone : ${d.clone_url}\nType  : ${d.private ? "Private 🔒" : "Public 🌍"}`);
      }

      case "delete_repo": {
        if (!a?.confirmed) {
          return ok(confirmationBlock("DELETE REPOSITORY", {
            Repo   : `${owner}/${a?.repo}`,
            WARNING: "PERMANENT — deletes code, issues, PRs, branches, releases",
          }));
        }
        await octokit.repos.delete({ owner, repo: a?.repo as string });
        return ok(`🗑️  ${owner}/${a?.repo} permanently deleted.`);
      }

      case "search_repos": {
        const { data } = await octokit.search.repos({ q: a?.query as string, per_page: (a?.per_page as number) ?? 10 });
        const lines = data.items.map(r => `📁 ${r.full_name} ⭐${r.stargazers_count}\n   ${r.description ?? ""}\n   ${r.html_url}`);
        return ok(`${data.total_count} results, showing ${lines.length}:\n\n${lines.join("\n\n")}`);
      }

      case "get_repo_topics": {
        const { data } = await octokit.repos.getAllTopics({ owner, repo: a?.repo as string });
        return ok(`Topics for ${owner}/${a?.repo}:\n${data.names.length ? data.names.map(t => `  • ${t}`).join("\n") : "  (none)"}`);
      }

      case "set_repo_topics": {
        await octokit.repos.replaceAllTopics({ owner, repo: a?.repo as string, names: a?.topics as string[] });
        return ok(`✅ Topics updated for ${owner}/${a?.repo}:\n${(a?.topics as string[]).map(t => `  • ${t}`).join("\n")}`);
      }

      case "fork_repo": {
        const { data: d } = await octokit.repos.createFork({ owner: a?.owner as string, repo: a?.repo as string });
        return ok(`✅ Forked!\nOriginal : ${a?.owner}/${a?.repo}\nYour fork: ${d.full_name}\nURL      : ${d.html_url}`);
      }

      case "get_repo_traffic": {
        const [views, clones] = await Promise.all([
          octokit.repos.getViews({ owner, repo: a?.repo as string }),
          octokit.repos.getClones({ owner, repo: a?.repo as string }),
        ]);
        const viewLines = views.data.views.slice(-7).map(v => `  ${v.timestamp.slice(0,10)}: ${v.count} views (${v.uniques} unique)`);
        const cloneLines = clones.data.clones.slice(-7).map(c => `  ${c.timestamp.slice(0,10)}: ${c.count} clones (${c.uniques} unique)`);
        return ok([
          `📊 Traffic for ${owner}/${a?.repo} (last 14 days)`,
          `Total views : ${views.data.count} (${views.data.uniques} unique)`,
          `Total clones: ${clones.data.count} (${clones.data.uniques} unique)`,
          "", "Daily views:", ...viewLines,
          "", "Daily clones:", ...cloneLines,
        ].join("\n"));
      }

      case "update_repo_settings": {
        const p: any = { owner, repo: a?.repo as string };
        if (a?.description !== undefined) p.description = a.description;
        if (a?.homepage    !== undefined) p.homepage    = a.homepage;
        if (a?.private     !== undefined) p.private     = a.private;
        if (a?.has_issues  !== undefined) p.has_issues  = a.has_issues;
        if (a?.has_wiki    !== undefined) p.has_wiki    = a.has_wiki;
        if (a?.has_projects!== undefined) p.has_projects= a.has_projects;
        const { data: d } = await octokit.repos.update(p);
        return ok(`✅ Settings updated: ${d.full_name}\n${d.html_url}`);
      }

      // ══ BRANCHES ════════════════════════════════════════════════════════════

      case "list_branches": {
        const { data } = await octokit.repos.listBranches({ owner, repo: a?.repo as string, per_page: 100 });
        const lines = data.map((b, i) => `${String(i+1).padStart(2)}. ${b.name.padEnd(30)} ${b.commit.sha.slice(0,7)} ${b.protected ? "🔒" : ""}`);
        return ok(`Branches in ${owner}/${a?.repo} (${data.length}):\n\n${lines.join("\n")}`);
      }

      case "get_branch": {
        const { data: d } = await octokit.repos.getBranch({ owner, repo: a?.repo as string, branch: a?.branch as string });
        return ok([
          `🌿 ${d.name} in ${owner}/${a?.repo}`,
          `Latest SHA : ${d.commit.sha}`,
          `Protected  : ${d.protected ? "Yes 🔒" : "No"}`,
        ].join("\n"));
      }

      case "create_branch": {
        const db = await defaultBranch(octokit, owner, a?.repo as string);
        const from = (a?.from_branch as string) ?? db;
        const { data: ref } = await octokit.git.getRef({ owner, repo: a?.repo as string, ref: `heads/${from}` });
        await octokit.git.createRef({ owner, repo: a?.repo as string, ref: `refs/heads/${a?.new_branch}`, sha: ref.object.sha });
        return ok(`✅ Branch created!\nRepo   : ${owner}/${a?.repo}\nNew br : ${a?.new_branch}\nFrom   : ${from} (${ref.object.sha.slice(0,7)})`);
      }

      case "delete_branch": {
        if (!a?.confirmed) {
          return ok(confirmationBlock("DELETE BRANCH", {
            Repo   : `${owner}/${a?.repo}`,
            Branch : a?.branch as string,
            WARNING: "Unmerged commits will be lost",
          }));
        }
        await octokit.git.deleteRef({ owner, repo: a?.repo as string, ref: `heads/${a?.branch}` });
        return ok(`🗑️  Branch '${a?.branch}' deleted from ${owner}/${a?.repo}`);
      }

      case "rename_branch": {
        await octokit.repos.renameBranch({ owner, repo: a?.repo as string, branch: a?.branch as string, new_name: a?.new_name as string });
        return ok(`✅ Branch renamed: ${a?.branch} → ${a?.new_name} in ${owner}/${a?.repo}`);
      }

      case "get_branch_protection": {
        try {
          const { data: d } = await octokit.repos.getBranchProtection({ owner, repo: a?.repo as string, branch: a?.branch as string });
          return ok([
            `🔒 Protection for '${a?.branch}' in ${owner}/${a?.repo}`,
            `Require PR reviews    : ${d.required_pull_request_reviews ? "Yes" : "No"}`,
            `Required status checks: ${d.required_status_checks?.contexts?.join(", ") ?? "none"}`,
            `Enforce admins        : ${d.enforce_admins?.enabled ? "Yes" : "No"}`,
          ].join("\n"));
        } catch {
          return ok(`Branch '${a?.branch}' in ${owner}/${a?.repo} has no protection rules.`);
        }
      }

      // ══ COMMITS ═════════════════════════════════════════════════════════════

      case "list_commits": {
        const db = await defaultBranch(octokit, owner, a?.repo as string);
        const p: any = { owner, repo: a?.repo as string, sha: (a?.branch as string) ?? db, per_page: (a?.per_page as number) ?? 15 };
        if (a?.since)  p.since  = new Date(a.since  as string).toISOString();
        if (a?.until)  p.until  = new Date(a.until  as string).toISOString();
        if (a?.author) p.author = a.author;
        const { data } = await octokit.repos.listCommits(p);
        const lines = data.map((c, i) =>
          `${String(i+1).padStart(2)}. ${c.sha.slice(0,7)} | ${c.commit.author?.date?.slice(0,10)} | ${(c.commit.author?.name ?? "?").padEnd(18)} | ${c.commit.message.split("\n")[0]}`
        );
        return ok(`Commits on '${p.sha}' in ${owner}/${a?.repo} (${data.length}):\n\n${lines.join("\n")}`);
      }

      case "get_commit_diff": {
        const { data: d } = await octokit.repos.getCommit({ owner, repo: a?.repo as string, ref: a?.commit_sha as string });
        const files = (d.files ?? []).map(f => `  ${f.status.toUpperCase().padEnd(8)} ${f.filename}  +${f.additions} -${f.deletions}`);
        return ok([
          `📝 Commit ${d.sha.slice(0,7)} in ${owner}/${a?.repo}`,
          `Author  : ${d.commit.author?.name} <${d.commit.author?.email}>`,
          `Date    : ${d.commit.author?.date?.slice(0,10)}`,
          `Message : ${d.commit.message}`,
          ``, `Changed files (${d.files?.length ?? 0}):`, ...files,
          ``, `Total: +${d.stats?.additions} -${d.stats?.deletions} lines`,
        ].join("\n"));
      }

      case "compare_branches": {
        const { data: d } = await octokit.repos.compareCommitsWithBasehead({ owner, repo: a?.repo as string, basehead: `${a?.base}...${a?.head}` });
        const commits = d.commits.map(c => `  ${c.sha.slice(0,7)} ${c.commit.message.split("\n")[0]}`);
        return ok([
          `📊 ${owner}/${a?.repo}: '${a?.base}' vs '${a?.head}'`,
          `Status  : ${d.status}  |  Ahead: ${d.ahead_by}  |  Behind: ${d.behind_by}`,
          `Files Δ : ${d.files?.length ?? 0}`,
          ``, `Commits only in '${a?.head}' (${d.commits.length}):`, ...commits,
        ].join("\n"));
      }

      case "get_commit_history": {
        const db = await defaultBranch(octokit, owner, a?.repo as string);
        const branch = (a?.branch as string) ?? db;
        const { data } = await octokit.repos.listCommits({ owner, repo: a?.repo as string, sha: branch, per_page: (a?.per_page as number) ?? 20 });
        const lines = data.map(c => {
          const date   = c.commit.author?.date?.slice(0,10) ?? "unknown";
          const author = (c.commit.author?.name ?? "?").slice(0,18).padEnd(20);
          const msg    = c.commit.message.split("\n")[0].slice(0,55);
          return `${c.sha.slice(0,7)}  ${date}  ${author}  ${msg}`;
        });
        return ok(`📜 History — ${owner}/${a?.repo} on '${branch}':\n\nSHA      Date        Author                Message\n${"─".repeat(85)}\n${lines.join("\n")}`);
      }

      // ══ FILES & CONTENT ══════════════════════════════════════════════════════

      case "get_file_contents": {
        const db  = await defaultBranch(octokit, owner, a?.repo as string);
        const ref = (a?.branch as string) ?? db;
        const { data: d } = await octokit.repos.getContent({ owner, repo: a?.repo as string, path: a?.path as string, ref });
        if ("content" in d && !Array.isArray(d)) {
          const text = Buffer.from(d.content, "base64").toString("utf-8");
          return ok(`📄 ${d.path}  (${d.size} bytes, SHA: ${d.sha.slice(0,7)}, branch: ${ref})\n\n${text}`);
        }
        return ok("That path is a directory. Use list_directory instead.");
      }

      case "list_directory": {
        const db  = await defaultBranch(octokit, owner, a?.repo as string);
        const ref = (a?.branch as string) ?? db;
        const { data: d } = await octokit.repos.getContent({ owner, repo: a?.repo as string, path: (a?.path as string) ?? "", ref });
        if (Array.isArray(d)) {
          const lines = d.map(i => `${i.type === "dir" ? "📁" : "📄"} ${i.name.padEnd(38)} ${i.type === "file" ? `${i.size} bytes` : ""}`);
          return ok(`Contents of ${owner}/${a?.repo}/${a?.path ?? ""}:\n\n${lines.join("\n")}`);
        }
        return ok("That path is a file. Use get_file_contents instead.");
      }

      case "create_or_update_file": {
        if (!a?.confirmed) {
          return ok(confirmationBlock("CREATE / UPDATE FILE", {
            Repo   : `${owner}/${a?.repo}`,
            File   : a?.path as string,
            Branch : (a?.branch as string) ?? "default branch",
            Commit : a?.message as string,
            Preview: `${(a?.content as string).slice(0,80)}...`,
          }));
        }
        const db  = await defaultBranch(octokit, owner, a?.repo as string);
        const branch = (a?.branch as string) ?? db;
        const content = Buffer.from(a?.content as string).toString("base64");
        let sha: string | undefined;
        try {
          const { data: ex } = await octokit.repos.getContent({ owner, repo: a?.repo as string, path: a?.path as string, ref: branch });
          if (!Array.isArray(ex) && "sha" in ex) sha = ex.sha;
        } catch { /* new file */ }
        const { data: d } = await octokit.repos.createOrUpdateFileContents({
          owner, repo: a?.repo as string, path: a?.path as string,
          message: a?.message as string, content, branch, sha,
        });
        return ok(`✅ File ${sha ? "updated" : "created"}!\nRepo   : ${owner}/${a?.repo}\nFile   : ${a?.path}\nBranch : ${branch}\nCommit : ${d.commit.sha?.slice(0,7)}\nURL    : ${d.content?.html_url}`);
      }

      case "delete_file": {
        if (!a?.confirmed) {
          return ok(confirmationBlock("DELETE FILE", {
            Repo   : `${owner}/${a?.repo}`,
            File   : a?.path as string,
            Branch : (a?.branch as string) ?? "default branch",
            Commit : a?.message as string,
          }));
        }
        const db  = await defaultBranch(octokit, owner, a?.repo as string);
        const branch = (a?.branch as string) ?? db;
        const { data: ex } = await octokit.repos.getContent({ owner, repo: a?.repo as string, path: a?.path as string, ref: branch });
        if (Array.isArray(ex) || !("sha" in ex)) return ok("Path is a directory, not a file.");
        await octokit.repos.deleteFile({ owner, repo: a?.repo as string, path: a?.path as string, message: a?.message as string, sha: ex.sha, branch });
        return ok(`🗑️  File '${a?.path}' deleted from ${owner}/${a?.repo} on '${branch}'`);
      }

      // ══ ISSUES ══════════════════════════════════════════════════════════════

      case "list_issues": {
        const p: any = { owner, repo: a?.repo as string, state: (a?.state as any) ?? "open", per_page: (a?.per_page as number) ?? 20 };
        if (a?.label) p.labels = a.label;
        const { data } = await octokit.issues.listForRepo(p);
        const issues = data.filter(i => !i.pull_request);
        const lines  = issues.map(i => {
          const labels = i.labels.map((l: any) => l.name ?? l).join(", ");
          return `#${i.number} [${i.state}] ${i.title}\n   @${i.user?.login} | Labels: ${labels || "none"} | 💬 ${i.comments}`;
        });
        return ok(`Issues in ${owner}/${a?.repo} (${issues.length}):\n\n${lines.join("\n\n") || "None found."}`);
      }

      case "get_issue": {
        const { data: issue }    = await octokit.issues.get({ owner, repo: a?.repo as string, issue_number: a?.issue_number as number });
        const { data: comments } = await octokit.issues.listComments({ owner, repo: a?.repo as string, issue_number: a?.issue_number as number });
        const labels = issue.labels.map((l: any) => l.name ?? l).join(", ");
        return ok([
          `🐛 #${issue.number}: ${issue.title}`,
          `State     : ${issue.state}`, `By        : @${issue.user?.login}`,
          `Labels    : ${labels || "none"}`,
          `Assignees : ${issue.assignees?.map((a: any) => `@${a.login}`).join(", ") || "none"}`,
          `Milestone : ${issue.milestone?.title ?? "none"}`,
          `Created   : ${issue.created_at.slice(0,10)}`, `URL: ${issue.html_url}`,
          ``, `Description:`, issue.body ?? "(none)",
          ``, `Comments (${comments.length}):`,
          ...comments.map(c => `  @${c.user?.login} (${c.created_at.slice(0,10)}): ${c.body?.slice(0,200)}`),
        ].join("\n"));
      }

      case "create_issue": {
        const { data: d } = await octokit.issues.create({
          owner, repo: a?.repo as string, title: a?.title as string,
          body: (a?.body as string) ?? "", labels: (a?.labels as string[]) ?? [],
          assignees: (a?.assignees as string[]) ?? [], milestone: a?.milestone as number,
        });
        return ok(`✅ Issue created!\n#${d.number} — ${d.title}\nURL: ${d.html_url}`);
      }

      case "update_issue": {
        const p: any = { owner, repo: a?.repo as string, issue_number: a?.issue_number as number };
        if (a?.title)     p.title     = a.title;
        if (a?.body)      p.body      = a.body;
        if (a?.state)     p.state     = a.state;
        if (a?.labels)    p.labels    = a.labels;
        if (a?.milestone) p.milestone = a.milestone;
        const { data: d } = await octokit.issues.update(p);
        return ok(`✅ Issue #${d.number} updated — ${d.state}\nURL: ${d.html_url}`);
      }

      case "comment_on_issue": {
        const { data: d } = await octokit.issues.createComment({ owner, repo: a?.repo as string, issue_number: a?.issue_number as number, body: a?.body as string });
        return ok(`✅ Comment posted on #${a?.issue_number}\nURL: ${d.html_url}`);
      }

      case "list_labels": {
        const { data } = await octokit.issues.listLabelsForRepo({ owner, repo: a?.repo as string, per_page: 100 });
        const lines = data.map(l => `  #${l.color}  ${l.name}${l.description ? ` — ${l.description}` : ""}`);
        return ok(`Labels in ${owner}/${a?.repo} (${data.length}):\n\n${lines.join("\n")}`);
      }

      case "create_label": {
        const { data: d } = await octokit.issues.createLabel({ owner, repo: a?.repo as string, name: a?.name as string, color: a?.color as string, description: (a?.description as string) ?? "" });
        return ok(`✅ Label created: "${d.name}" (#${d.color}) in ${owner}/${a?.repo}`);
      }

      case "list_milestones": {
        const { data } = await octokit.issues.listMilestones({ owner, repo: a?.repo as string, state: (a?.state as any) ?? "open" });
        const lines = data.map(m => `#${m.number} ${m.title} — ${m.open_issues} open / ${m.closed_issues} closed | Due: ${m.due_on?.slice(0,10) ?? "none"}`);
        return ok(`Milestones in ${owner}/${a?.repo}:\n\n${lines.join("\n") || "None."}`);
      }

      case "create_milestone": {
        const { data: d } = await octokit.issues.createMilestone({
          owner, repo: a?.repo as string, title: a?.title as string,
          description: (a?.description as string) ?? "", due_on: a?.due_on as string,
        });
        return ok(`✅ Milestone created: #${d.number} "${d.title}"\nURL: ${d.html_url}`);
      }

      // ══ PULL REQUESTS ════════════════════════════════════════════════════════

      case "list_pull_requests": {
        const { data } = await octokit.pulls.list({ owner, repo: a?.repo as string, state: (a?.state as any) ?? "open" });
        const lines = data.map(pr => `#${pr.number} [${pr.state}] ${pr.title}\n   ${pr.head.ref} → ${pr.base.ref} | @${pr.user?.login}`);
        return ok(`PRs in ${owner}/${a?.repo} (${data.length}):\n\n${lines.join("\n\n") || "None."}`);
      }

      case "get_pull_request": {
        const { data: d } = await octokit.pulls.get({ owner, repo: a?.repo as string, pull_number: a?.pull_number as number });
        return ok([
          `🔀 PR #${d.number}: ${d.title}`,
          `State     : ${d.state}${d.merged ? " (merged ✅)" : ""}`,
          `By        : @${d.user?.login}`,
          `Branches  : ${d.head.ref} → ${d.base.ref}`,
          `Mergeable : ${d.mergeable ?? "checking..."}`,
          `Stats     : ${d.commits} commits | ${d.changed_files} files | +${d.additions} -${d.deletions}`,
          `Created   : ${d.created_at.slice(0,10)}  |  URL: ${d.html_url}`,
          ``, `Description:`, d.body ?? "(none)",
        ].join("\n"));
      }

      case "create_pull_request": {
        const { data: d } = await octokit.pulls.create({
          owner, repo: a?.repo as string, title: a?.title as string,
          head: a?.head as string, base: (a?.base as string) ?? "main",
          body: (a?.body as string) ?? "", draft: (a?.draft as boolean) ?? false,
        });
        return ok(`✅ PR created!\n#${d.number}: ${d.title}\n${d.head.ref} → ${d.base.ref}\nURL: ${d.html_url}`);
      }

      case "merge_pull_request": {
        if (!a?.confirmed) {
          const { data: pr } = await octokit.pulls.get({ owner, repo: a?.repo as string, pull_number: a?.pull_number as number });
          return ok(confirmationBlock("MERGE PULL REQUEST", {
            Repo   : `${owner}/${a?.repo}`,
            PR     : `#${pr.number} — ${pr.title}`,
            From   : pr.head.ref, Into: pr.base.ref,
            Method : (a?.merge_method as string) ?? "merge",
            Stats  : `${pr.commits} commits | +${pr.additions} -${pr.deletions}`,
          }));
        }
        await octokit.pulls.merge({
          owner, repo: a?.repo as string, pull_number: a?.pull_number as number,
          merge_method: (a?.merge_method as any) ?? "merge",
          commit_title: a?.commit_title as string,
        });
        return ok(`✅ PR #${a?.pull_number} merged into ${owner}/${a?.repo}!`);
      }

      case "get_pr_diff": {
        const { data } = await octokit.pulls.listFiles({ owner, repo: a?.repo as string, pull_number: a?.pull_number as number });
        const lines = data.map(f => `${f.status.toUpperCase().padEnd(8)} ${f.filename}   +${f.additions} -${f.deletions}`);
        return ok(`Files in PR #${a?.pull_number} (${data.length}):\n\n${lines.join("\n")}`);
      }

      case "request_pr_review": {
        await octokit.pulls.requestReviewers({ owner, repo: a?.repo as string, pull_number: a?.pull_number as number, reviewers: a?.reviewers as string[] });
        return ok(`✅ Review requested from: ${(a?.reviewers as string[]).map(r => `@${r}`).join(", ")}\nPR #${a?.pull_number} in ${owner}/${a?.repo}`);
      }

      case "list_pr_reviews": {
        const { data } = await octokit.pulls.listReviews({ owner, repo: a?.repo as string, pull_number: a?.pull_number as number });
        const lines = data.map(r => `@${r.user?.login} [${r.state}] — ${r.submitted_at?.slice(0,10)}\n  ${r.body?.slice(0,200) || "(no comment)"}`);
        return ok(`Reviews on PR #${a?.pull_number} (${data.length}):\n\n${lines.join("\n\n") || "None."}`);
      }

      // ══ RELEASES & TAGS ══════════════════════════════════════════════════════

      case "list_releases": {
        const { data } = await octokit.repos.listReleases({ owner, repo: a?.repo as string, per_page: (a?.per_page as number) ?? 10 });
        const lines = data.map(r => `🏷️  ${r.tag_name} — ${r.name ?? "untitled"}\n   ${r.published_at?.slice(0,10) ?? "draft"} | ${r.draft ? "DRAFT" : r.prerelease ? "PRE-RELEASE" : "Stable"}\n   ${r.html_url}`);
        return ok(`Releases for ${owner}/${a?.repo} (${data.length}):\n\n${lines.join("\n\n") || "None."}`);
      }

      case "get_latest_release": {
        const { data: d } = await octokit.repos.getLatestRelease({ owner, repo: a?.repo as string });
        return ok(`Latest release: ${d.tag_name} — ${d.name}\n${d.published_at?.slice(0,10)}\n\n${d.body ?? "(no notes)"}\n\nURL: ${d.html_url}`);
      }

      case "create_release": {
        const { data: d } = await octokit.repos.createRelease({
          owner, repo: a?.repo as string, tag_name: a?.tag_name as string,
          name: a?.name as string, body: (a?.body as string) ?? "",
          draft: (a?.draft as boolean) ?? false, prerelease: (a?.prerelease as boolean) ?? false,
          target_commitish: (a?.target_commitish as string) ?? "main",
        });
        return ok(`✅ Release created!\nTag : ${d.tag_name}\nName: ${d.name}\nURL : ${d.html_url}`);
      }

      case "list_tags": {
        const { data } = await octokit.repos.listTags({ owner, repo: a?.repo as string, per_page: (a?.per_page as number) ?? 30 });
        const lines = data.map(t => `${t.name.padEnd(25)} ${t.commit.sha.slice(0,7)}`);
        return ok(`Tags in ${owner}/${a?.repo} (${data.length}):\n\n${lines.join("\n") || "None."}`);
      }

      // ══ GITHUB ACTIONS / WORKFLOWS ════════════════════════════════════════

      case "list_workflows": {
        const { data } = await octokit.actions.listRepoWorkflows({ owner, repo: a?.repo as string });
        const lines = data.workflows.map(w => `  ${w.name.padEnd(30)} ${w.path}  [${w.state}]`);
        return ok(`Workflows in ${owner}/${a?.repo} (${data.total_count}):\n\n${lines.join("\n") || "None."}`);
      }

      case "list_workflow_runs": {
        const p: any = { owner, repo: a?.repo as string, per_page: (a?.per_page as number) ?? 15 };
        if (a?.workflow_id) p.workflow_id = a.workflow_id;
        if (a?.branch)      p.branch      = a.branch;
        if (a?.status)      p.status      = a.status;

        let data: any[];
        if (a?.workflow_id) {
          const res = await octokit.actions.listWorkflowRuns({ ...p, workflow_id: a.workflow_id as any });
          data = res.data.workflow_runs;
        } else {
          const res = await octokit.actions.listWorkflowRunsForRepo(p);
          data = res.data.workflow_runs;
        }

        const lines = data.map(r =>
          `#${r.id} ${r.name ?? r.workflow_id} [${r.status}/${r.conclusion ?? "…"}]\n   Branch: ${r.head_branch} | ${r.created_at.slice(0,10)} | ${r.html_url}`
        );
        return ok(`Workflow runs in ${owner}/${a?.repo} (${data.length} shown):\n\n${lines.join("\n\n")}`);
      }

      case "get_workflow_run": {
        const { data: d } = await octokit.actions.getWorkflowRun({ owner, repo: a?.repo as string, run_id: a?.run_id as number });
        const { data: jobs } = await octokit.actions.listJobsForWorkflowRun({ owner, repo: a?.repo as string, run_id: a?.run_id as number });
        const jobLines = jobs.jobs.map(j => `  ${j.name.padEnd(35)} [${j.status}/${j.conclusion ?? "…"}] ${j.started_at?.slice(0,10)}`);
        return ok([
          `⚙️  Run #${d.id}: ${d.name}`,
          `Status     : ${d.status} / ${d.conclusion ?? "running"}`,
          `Branch     : ${d.head_branch}  |  Commit: ${d.head_sha.slice(0,7)}`,
          `Triggered  : ${d.event}  |  Started: ${d.created_at.slice(0,10)}`,
          `URL        : ${d.html_url}`,
          ``, `Jobs (${jobs.jobs.length}):`, ...jobLines,
        ].join("\n"));
      }

      case "rerun_workflow": {
        await octokit.actions.reRunWorkflow({ owner, repo: a?.repo as string, run_id: a?.run_id as number });
        return ok(`🔁 Re-triggered workflow run #${a?.run_id} in ${owner}/${a?.repo}`);
      }

      case "cancel_workflow_run": {
        if (!a?.confirmed) {
          return ok(confirmationBlock("CANCEL WORKFLOW RUN", { Repo: `${owner}/${a?.repo}`, RunID: String(a?.run_id) }));
        }
        await octokit.actions.cancelWorkflowRun({ owner, repo: a?.repo as string, run_id: a?.run_id as number });
        return ok(`🛑 Workflow run #${a?.run_id} cancellation requested.`);
      }

      case "trigger_workflow": {
        await octokit.actions.createWorkflowDispatch({
          owner, repo: a?.repo as string, workflow_id: a?.workflow_id as string,
          ref: (a?.ref as string) ?? "main", inputs: (a?.inputs as any) ?? {},
        });
        return ok(`🚀 Workflow '${a?.workflow_id}' triggered on '${a?.ref ?? "main"}' in ${owner}/${a?.repo}`);
      }

      // ══ STATS, ACTIVITY & PROFILE ════════════════════════════════════════

      case "get_repo_stats": {
        const [langRes, contribRes, repoRes] = await Promise.all([
          octokit.repos.listLanguages({ owner, repo: a?.repo as string }),
          octokit.repos.getContributorsStats({ owner, repo: a?.repo as string }),
          octokit.repos.get({ owner, repo: a?.repo as string }),
        ]);
        const total = Object.values(langRes.data).reduce((s: number, b) => s + (b as number), 0);
        const langs = Object.entries(langRes.data)
          .sort(([,a],[,b]) => (b as number) - (a as number))
          .map(([l, b]) => `  ${l}: ${(((b as number)/total)*100).toFixed(1)}%`).join("\n");
        const contribs = Array.isArray(contribRes.data)
          ? contribRes.data.sort((a,b) => (b.total ?? 0)-(a.total ?? 0)).slice(0,8)
              .map(c => `  @${(c.author?.login ?? "?").padEnd(20)} ${c.total} commits`).join("\n")
          : "  Still computing — try again in a moment.";
        return ok([
          `📊 ${owner}/${a?.repo}`,
          `⭐ ${repoRes.data.stargazers_count}  🍴 ${repoRes.data.forks_count}  🐛 ${repoRes.data.open_issues_count} issues`,
          ``, `Languages:`, langs, ``, `Top contributors:`, contribs,
        ].join("\n"));
      }

      case "get_repo_traffic": {
        const [views, clones] = await Promise.all([
          octokit.repos.getViews({ owner, repo: a?.repo as string }),
          octokit.repos.getClones({ owner, repo: a?.repo as string }),
        ]);
        const vLines = views.data.views.slice(-7).map(v => `  ${v.timestamp.slice(0,10)}: ${v.count} views (${v.uniques} unique)`);
        const cLines = clones.data.clones.slice(-7).map(c => `  ${c.timestamp.slice(0,10)}: ${c.count} clones (${c.uniques} unique)`);
        return ok([
          `📊 Traffic for ${owner}/${a?.repo}`,
          `Views (14d) : ${views.data.count} total / ${views.data.uniques} unique`,
          `Clones (14d): ${clones.data.count} total / ${clones.data.uniques} unique`,
          ``, `Recent views:`, ...vLines, ``, `Recent clones:`, ...cLines,
        ].join("\n"));
      }

      case "get_my_activity": {
        const { data } = await octokit.activity.listEventsForAuthenticatedUser({ username: GITHUB_USERNAME!, per_page: (a?.per_page as number) ?? 20 });
        const lines = data.map(e => {
          const date = e.created_at?.slice(0,10) ?? "?";
          const repo  = (e.repo as any)?.name ?? "?";
          return `${date} | ${(e.type?.replace("Event","") ?? "?").padEnd(14)} | ${repo}`;
        });
        return ok(`Recent activity for @${GITHUB_USERNAME}:\n\nDate       | Action         | Repo\n${"─".repeat(60)}\n${lines.join("\n")}`);
      }

      case "get_my_profile": {
        const { data: d } = await octokit.users.getAuthenticated();
        return ok([
          `👤 @${d.login}`,
          `Name         : ${d.name ?? "not set"}`,
          `Bio          : ${d.bio ?? "not set"}`,
          `Company      : ${d.company ?? "not set"}`,
          `Location     : ${d.location ?? "not set"}`,
          `Website      : ${d.blog ?? "not set"}`,
          `Public repos : ${d.public_repos}`,
          `Private repos: ${d.total_private_repos ?? 0}`,
          `Followers    : ${d.followers}  |  Following: ${d.following}`,
          `Joined       : ${d.created_at.slice(0,10)}`,
          `Profile URL  : ${d.html_url}`,
        ].join("\n"));
      }

      case "list_notifications": {
        const { data } = await octokit.activity.listNotificationsForAuthenticatedUser({ all: (a?.all as boolean) ?? false, per_page: (a?.per_page as number) ?? 20 });
        if (!data.length) return ok("🎉 No unread notifications!");
        const lines = data.map(n => `[${n.reason}] ${n.subject.title}\n   ${n.repository.full_name} | ${n.updated_at.slice(0,10)}`);
        return ok(`Notifications (${data.length}):\n\n${lines.join("\n\n")}`);
      }

      case "star_repo": {
        await octokit.activity.starRepoForAuthenticatedUser({ owner: a?.owner as string, repo: a?.repo as string });
        return ok(`⭐ Starred ${a?.owner}/${a?.repo}`);
      }

      case "unstar_repo": {
        await octokit.activity.unstarRepoForAuthenticatedUser({ owner: a?.owner as string, repo: a?.repo as string });
        return ok(`Unstarred ${a?.owner}/${a?.repo}`);
      }

      case "list_starred_repos": {
        const { data } = await octokit.activity.listReposStarredByAuthenticatedUser({ per_page: (a?.per_page as number) ?? 30 });
        const lines = (data as any[]).map((r: any) => `⭐ ${r.full_name} — ${r.description ?? ""}`);
        return ok(`Your starred repos (${data.length}):\n\n${lines.join("\n")}`);
      }

      // ══ SEARCH ══════════════════════════════════════════════════════════════

      case "search_code": {
        let q = a?.query as string;
        if (a?.repo)     q += ` repo:${a.repo}`;
        if (a?.language) q += ` language:${a.language}`;
        const { data } = await octokit.search.code({ q, per_page: (a?.per_page as number) ?? 10 });
        const lines = data.items.map(i => `📄 ${i.repository.full_name} — ${i.path}\n   ${i.html_url}`);
        return ok(`Code results (${data.total_count} total, ${lines.length} shown):\n\n${lines.join("\n\n")}`);
      }

      case "search_issues": {
        const { data } = await octokit.search.issuesAndPullRequests({ q: a?.query as string, per_page: (a?.per_page as number) ?? 10 });
        const lines = data.items.map(i =>
          `${i.pull_request ? "🔀 PR" : "🐛 Issue"} #${i.number} [${i.state}] ${i.title}\n   ${i.repository_url.split("/").slice(-2).join("/")} | @${i.user?.login}\n   ${i.html_url}`
        );
        return ok(`Search results (${data.total_count} total):\n\n${lines.join("\n\n")}`);
      }

      case "search_commits": {
        let q = a?.query as string;
        if (a?.repo) q += ` repo:${a.repo}`;
        const { data } = await octokit.search.commits({ q, per_page: (a?.per_page as number) ?? 10 });
        const lines = data.items.map(c =>
          `${c.sha.slice(0,7)} ${c.commit.message.split("\n")[0]}\n   ${(c.repository as any).full_name} | @${c.author?.login ?? c.commit.author?.name} | ${c.commit.author?.date?.slice(0,10)}`
        );
        return ok(`Commit search (${data.total_count} results):\n\n${lines.join("\n\n")}`);
      }

      // ══ ADMIN & COLLABORATORS ════════════════════════════════════════════

      case "list_collaborators": {
        const { data } = await octokit.repos.listCollaborators({ owner, repo: a?.repo as string });
        const lines = data.map(u => {
          const perms = u.permissions ? Object.entries(u.permissions).filter(([,v])=>v).map(([k])=>k).join(", ") : "unknown";
          return `@${u.login.padEnd(25)} ${perms}`;
        });
        return ok(`Collaborators on ${owner}/${a?.repo} (${data.length}):\n\n${lines.join("\n")}`);
      }

      case "add_collaborator": {
        await octokit.repos.addCollaborator({ owner, repo: a?.repo as string, username: a?.username as string, permission: (a?.permission as any) ?? "push" });
        return ok(`✅ @${a?.username} invited as collaborator (${a?.permission ?? "push"}) on ${owner}/${a?.repo}`);
      }

      case "remove_collaborator": {
        if (!a?.confirmed) {
          return ok(confirmationBlock("REMOVE COLLABORATOR", {
            Repo: `${owner}/${a?.repo}`, User: `@${a?.username}`,
          }));
        }
        await octokit.repos.removeCollaborator({ owner, repo: a?.repo as string, username: a?.username as string });
        return ok(`🗑️  @${a?.username} removed from ${owner}/${a?.repo}`);
      }

      case "list_deploy_keys": {
        const { data } = await octokit.repos.listDeployKeys({ owner, repo: a?.repo as string });
        const lines = data.map(k => `${k.id} | ${k.title} | ${k.read_only ? "read-only" : "read-write"} | ${k.created_at.slice(0,10)}`);
        return ok(`Deploy keys for ${owner}/${a?.repo} (${data.length}):\n\n${lines.join("\n") || "None."}`);
      }

      default:
        return { content: [{ type: "text" as const, text: `❌ Unknown tool: ${name}` }], isError: true as const };
    }

  } catch (e: any) {
    return githubError(e);
  }
});

// ─── START ─────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`✅  GitHub MCP Server v3.0.0 — ${toolDefinitions.length} tools loaded for @${GITHUB_USERNAME}`);

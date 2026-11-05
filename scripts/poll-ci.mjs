import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readProjects } from "./project-registry.mjs";

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim() || `${command} exited ${result.status}`);
  return result.stdout.trim();
}

export function classifyCurrentCommit(runs, headSha) {
  const current = runs.filter((run) => run.headSha === headSha);
  if (!current.length || current.some((run) => run.status !== "completed")) return null;
  if (current.some((run) => ["failure", "timed_out", "action_required", "cancelled", "startup_failure"].includes(run.conclusion))) return "failed";
  if (current.every((run) => ["success", "neutral", "skipped"].includes(run.conclusion))) return "passed";
  return null;
}

export function failedCommitCount(runs) {
  return new Set(
    runs
      .filter((run) => run.status === "completed" && ["failure", "timed_out", "action_required", "cancelled", "startup_failure"].includes(run.conclusion))
      .map((run) => run.headSha)
      .filter(Boolean),
  ).size;
}

export function normalizeGitLabPipelines(pipelines) {
  const conclusions = {
    success: "success",
    failed: "failure",
    canceled: "cancelled",
    skipped: "skipped",
  };
  return pipelines.map((pipeline) => {
    const conclusion = conclusions[pipeline.status] ?? null;
    return {
      databaseId: pipeline.id,
      name: pipeline.name || `GitLab pipeline ${pipeline.id}`,
      status: conclusion ? "completed" : "in_progress",
      conclusion,
      headSha: pipeline.sha,
      url: pipeline.web_url,
    };
  });
}

export function makeCIEvent({ taskId, headSha, runs, repairLimit = 2, projectId = "" }) {
  const state = classifyCurrentCommit(runs, headSha);
  if (!state) return null;
  const current = runs.filter((run) => run.headSha === headSha);
  const failedRuns = current.filter((run) => run.conclusion !== "success" && run.conclusion !== "neutral" && run.conclusion !== "skipped");
  const failedCommits = failedCommitCount(runs);
  const repairAttempt = Math.max(0, failedCommits - 1);
  const repairExhausted = repairAttempt >= repairLimit;
  const workflowRuns = current.map(({ databaseId, name, conclusion, url }) => ({ databaseId, name, conclusion, url }));
  return {
    id: `github-ci-${projectId ? `${projectId}-` : ""}${state}-${headSha}`,
    type: projectId ? `ci.${projectId}.${state}` : state === "failed" ? "ci.failed" : "ci.passed",
    subject: taskId,
    summary: state === "failed"
      ? repairExhausted
        ? `GitHub CI 再次失败：已用尽 ${repairLimit} 轮自动修复`
        : `GitHub CI 未通过：已修复 ${repairAttempt} 轮，最多 ${repairLimit} 轮`
      : "GitHub CI 已通过",
    detail: JSON.stringify({ taskId, headSha, failedCommits, repairAttempt, repairLimit, repairExhausted, runs: workflowRuns }),
    link: failedRuns[0]?.url ?? current[0]?.url ?? "",
    hops: 0,
  };
}

function trackedTasks(codexHome) {
  const root = join(codexHome, "worktrees", "codex-idea-delivery");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((worktree) => existsSync(join(worktree, "task-context.json")))
    .map((worktree) => ({ worktree, context: JSON.parse(readFileSync(join(worktree, "task-context.json"), "utf8")) }));
}

function originUrl(worktree) {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : "";
}

function remoteHost(remote) {
  const scp = remote.match(/^[^@]+@([^:/]+):/);
  if (scp) return scp[1].toLowerCase();
  try { return new URL(remote).hostname.toLowerCase(); } catch { return ""; }
}

export function resolveProvider({ remote, context, worktree }) {
  const host = remoteHost(remote);
  const explicit = context.repository?.provider;
  if (explicit && !["github", "gitlab"].includes(explicit)) throw new Error(`不支持的仓库服务类型：${explicit}`);
  const provider = explicit || (host === "github.com"
    ? "github"
    : (/gitlab/i.test(host) || existsSync(join(worktree, ".gitlab-ci.yml")) ? "gitlab" : ""));
  if (!provider) return null;
  if (provider === "github" && host !== "github.com") throw new Error(`origin 主机 ${host} 与 repository.provider=github 不匹配`);
  if (provider === "gitlab" && host === "github.com") throw new Error("origin 主机 github.com 与 repository.provider=gitlab 不匹配");
  return { provider, host };
}

function authCommand(provider, host) {
  return provider === "github"
    ? ["gh", ["auth", "status"]]
    : ["glab", ["auth", "status", "--hostname", host]];
}

function authenticationNeeded(contextPath, provider, host) {
  const [command, args] = authCommand(provider, host);
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (!result.error && result.status === 0) return false;
  let context = {};
  try { context = JSON.parse(readFileSync(contextPath, "utf8")); } catch {}
  const title = `恢复 ${provider === "github" ? "GitHub" : "GitLab"} CI 轮询（${host}）`;
  if (context.open?.some((card) => card.title === title)) return false;
  if (context.decided?.some((decision) => decision.title === title && decision.choice === "暂不处理")) return false;
  return true;
}

function writeAuthenticationCard(provider, host) {
  const gitlab = provider === "gitlab";
  const title = `恢复 ${gitlab ? "GitLab" : "GitHub"} CI 轮询（${host}）`;
  const instructions = gitlab
    ? `如尚未安装，请先安装 GitLab CLI（glab），再运行 glab auth login --hostname ${host}。`
    : "请在本机终端运行 gh auth login 并完成 GitHub 登录。";
  const receipt = {
    ask: [{
      title,
      text: instructions,
      options: ["我已登录", "暂不处理"],
      recommend: 0,
      about: "完成登录后，轮询会自动继续检查任务分支的 CI；不会自动合并或发布。",
      key: `${gitlab ? "gitlab" : "github"}-ci-auth-${host}`,
    }],
  };
  console.log("待你处理：GitHub CLI 还没有登录，暂时无法读取 CI 结果。");
  console.log("```agent-autoloop");
  console.log(JSON.stringify(receipt));
  console.log("```");
}

function pollTask({ worktree, context, provider, host, projectId }) {
  const taskId = context.taskId;
  const branch = run("git", ["branch", "--show-current"], worktree);
  if (!branch.startsWith("codex/") || branch !== context.repository?.branch) return null;
  const headSha = run("git", ["rev-parse", "HEAD"], worktree);
  const rows = provider === "github"
    ? JSON.parse(run("gh", ["run", "list", "--branch", branch, "--limit", "100", "--json", "databaseId,status,conclusion,headSha,url,name"], worktree))
    : normalizeGitLabPipelines(JSON.parse(run("glab", ["ci", "list", "--ref", branch, "--output", "json", "--per-page", "100"], worktree)));
  return makeCIEvent({ taskId, headSha, runs: rows, projectId });
}

function projectIdForContext(context, projects) {
  if (context.projectId && projects.some((project) => project.id === context.projectId)) return context.projectId;
  const repositoryPath = resolve(context.repository?.path || "");
  const matches = projects.filter((project) => resolve(project.path) === repositoryPath);
  if (matches.length === 1) return matches[0].id;
  if (projects.length === 1) return projects[0].id;
  throw new Error(`任务 ${context.taskId} 无法映射到唯一的已登记项目`);
}

function writeReceipt(events) {
  if (!events.length) {
    console.log("没事可做：没有新的 GitHub CI 结果。");
    return;
  }
  console.log(`发现 ${events.length} 条 GitHub CI 结果，交回任务 Router。`);
  console.log("```agent-autoloop");
  console.log(JSON.stringify({ events }));
  console.log("```");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    const autoHome = process.env.AGENT_AUTOLOOP_HOME || join(dirname(fileURLToPath(import.meta.url)), "../.local/agent-autoloop");
    const projects = readProjects(autoHome);
    const tasks = trackedTasks(codexHome).map((task) => {
      const remote = originUrl(task.worktree);
      const scm = remote ? resolveProvider({ remote, context: task.context, worktree: task.worktree }) : null;
      return scm ? { ...task, ...scm, projectId: projectIdForContext(task.context, projects) } : null;
    }).filter(Boolean);
    for (const task of tasks) {
      if (authenticationNeeded(process.env.AGENT_AUTOLOOP_CONTEXT, task.provider, task.host)) {
        writeAuthenticationCard(task.provider, task.host);
        process.exit(0);
      }
    }
    const events = tasks.map(pollTask).filter(Boolean);
    writeReceipt(events);
  } catch (error) {
    console.error(`GitHub CI 轮询失败：${error.message}`);
    process.exitCode = 1;
  }
}

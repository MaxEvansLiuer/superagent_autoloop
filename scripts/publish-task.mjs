import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function command(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim() || `${command} exited ${result.status}`);
  return result.stdout.trim();
}

function hostFromRemote(remote) {
  const scp = remote.match(/^[^@]+@([^:/]+):/);
  if (scp) return scp[1].toLowerCase();
  try { return new URL(remote).hostname.toLowerCase(); } catch { return ""; }
}

function canonicalPath(path) {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { return absolute; }
}

const LOCAL_TASK_FILES = new Set(["PROGRESS.md", "BLOCKED.md", "task-context.json"]);

function productWorktreeChanges(status) {
  return status.split(/\r?\n/).filter(Boolean).filter((line) => {
    const code = line.slice(0, 2);
    const path = line.slice(3);
    return !(code === "??" && LOCAL_TASK_FILES.has(path));
  });
}

export function repositoryProvider({ remote, context, worktree }) {
  const host = hostFromRemote(remote);
  const explicit = context.repository.provider;
  if (explicit && !["github", "gitlab"].includes(explicit)) throw new Error(`不支持的仓库服务类型：${explicit}`);
  const provider = explicit || (host === "github.com"
    ? "github"
    : (/gitlab/i.test(host) || existsSync(resolve(worktree, ".gitlab-ci.yml")) ? "gitlab" : ""));
  if (!provider) throw new Error(`无法识别 origin 服务 ${host || remote}；请在 task-context.json 的 repository.provider 指定 github 或 gitlab`);
  if (provider === "github" && host !== "github.com") throw new Error(`origin 主机 ${host} 与 repository.provider=github 不匹配`);
  if (provider === "gitlab" && host === "github.com") throw new Error("origin 主机 github.com 与 repository.provider=gitlab 不匹配");
  return { provider, host };
}

export async function publishTask({ context, cwd, run = command }) {
  if (!context?.taskId || !context.repository?.path || !context.repository?.branch || !context.repository?.worktree) {
    throw new Error("task-context.json 缺少 taskId、repository.path、repository.branch 或 repository.worktree");
  }
  const worktree = canonicalPath(cwd);
  if (canonicalPath(context.repository.worktree) !== worktree) throw new Error("当前目录与任务上下文记录的 Worktree 不一致");
  const repositoryPath = canonicalPath(context.repository.path);
  const [worktreeRoot, repositoryRoot] = await Promise.all([
    run("git", ["rev-parse", "--show-toplevel"], worktree),
    run("git", ["rev-parse", "--show-toplevel"], repositoryPath),
  ]);
  if (canonicalPath(worktreeRoot) !== worktree) throw new Error("发布目录不是任务 Worktree 根目录");
  if (canonicalPath(repositoryRoot) !== repositoryPath) throw new Error("task-context.json 的 repository.path 不是 Git 仓库根目录");
  const [worktreeCommonDir, repositoryCommonDir] = await Promise.all([
    run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], worktree),
    run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], repositoryPath),
  ]);
  if (canonicalPath(worktreeCommonDir) !== canonicalPath(repositoryCommonDir)) {
    throw new Error("任务 Worktree 与 task-context.json 记录的原仓库不属于同一个 Git 仓库");
  }

  const taskSlug = String(context.taskId).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!taskSlug) throw new Error("taskId 不能生成安全的任务分支名");
  const expectedBranch = `codex/${taskSlug}`;
  const branch = await run("git", ["branch", "--show-current"], worktree);
  if (branch !== expectedBranch || context.repository.branch !== expectedBranch) {
    throw new Error(`拒绝发布非当前任务分支：要求 ${expectedBranch}，当前 ${branch || "（分离 HEAD）"}，记录 ${context.repository.branch}`);
  }
  if (productWorktreeChanges(await run("git", ["status", "--porcelain"], worktree)).length) {
    throw new Error("Worktree 有未提交改动；先完成审查并提交，再发布");
  }

  const remotes = (await run("git", ["remote"], worktree)).split(/\r?\n/).filter(Boolean);
  if (!remotes.includes("origin")) return { published: false, reason: "仓库没有 origin 远端；保留本地任务分支" };
  const remote = await run("git", ["remote", "get-url", "origin"], worktree);
  const { provider, host } = repositoryProvider({ remote, context, worktree });
  const cli = provider === "github" ? "gh" : "glab";

  const refs = await run("git", ["ls-remote", "--heads", "origin", "main", "master"], worktree);
  const base = refs.split(/\r?\n/).map((line) => line.trim().split(/\s+/).at(-1)).includes("refs/heads/main")
    ? "main"
    : refs.split(/\r?\n/).map((line) => line.trim().split(/\s+/).at(-1)).includes("refs/heads/master")
      ? "master"
      : "";
  if (!base) throw new Error("远端不存在 main 或 master，无法安全确定 PR 基准分支");

  await run("git", ["fetch", "origin", base], worktree);
  await run("git", ["merge-base", "--is-ancestor", `origin/${base}`, "HEAD"], worktree);
  const ahead = Number(await run("git", ["rev-list", "--count", `origin/${base}..HEAD`], worktree));
  if (!Number.isInteger(ahead) || ahead < 1) throw new Error("任务分支没有领先基准分支的提交，拒绝创建空 PR");
  await run(cli, provider === "github" ? ["auth", "status"] : ["auth", "status", "--hostname", host], worktree);

  await run("git", ["push", "--set-upstream", "origin", branch], worktree);
  const listArgs = provider === "github"
    ? ["pr", "list", "--head", branch, "--json", "url,baseRefName", "--limit", "1"]
    : ["mr", "list", "--source-branch", branch, "--target-branch", base, "--output", "json", "--per-page", "1"];
  const existing = JSON.parse(await run(cli, listArgs, worktree));
  const existingUrl = existing[0]?.url ?? existing[0]?.web_url;
  const existingBase = existing[0]?.baseRefName ?? existing[0]?.target_branch;
  if (existingUrl) {
    if (existingBase && existingBase !== base) {
      throw new Error(`现有 PR/MR 的基准是 ${existingBase}，远端主分支为 ${base}；停止自动更新`);
    }
    return { published: true, provider, branch, base, url: existingUrl, reused: true };
  }

  const createArgs = provider === "github"
    ? ["pr", "create", "--base", base, "--head", branch, "--fill"]
    : ["mr", "create", "--target-branch", base, "--source-branch", branch, "--fill", "--push=false", "--yes"];
  const url = await run(cli, createArgs, worktree);
  return { published: true, provider, branch, base, url, reused: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const contextPath = resolve(process.argv[2] || "task-context.json");
  try {
    const context = JSON.parse(readFileSync(contextPath, "utf8"));
    const result = await publishTask({ context, cwd: process.cwd() });
    if (result.published) console.log(`${result.reused ? "复用现有" : "已创建"} ${result.provider === "gitlab" ? "MR" : "PR"}：${result.url}（${result.branch} → ${result.base}）`);
    else console.log(`未推送：${result.reason}`);
  } catch (error) {
    console.error(`发布停止：${error.message}`);
    process.exitCode = 1;
  }
}

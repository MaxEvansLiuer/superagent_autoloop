import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CODEX_PATHS = [
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
];
const APPROVAL_TITLE = "批准执行计划";
const APPROVAL_OPTION = "同意，开始实现";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

function git(repo, args, { allowFailure = false } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|PREFIX|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) {
      delete env[key];
    }
  }
  const result = run("git", args, { cwd: repo, env });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} 失败：${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

export function taskSlug(context) {
  const subject = context.events?.[0]?.subject;
  const slug = String(subject ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!slug) throw new Error("事件没有可用于隔离任务的对象编号");
  return slug;
}

export function hasImplementationApproval(turn, context) {
  const previousApproval = Boolean(
    context.decided?.some((decision) => decision.title === APPROVAL_TITLE && decision.choice === APPROVAL_OPTION),
  );
  if (previousApproval) return true;
  if (!turn.resume) return false;
  return Boolean(
    context.answers?.some(
      (answer) => answer.title === APPROVAL_TITLE && answer.options?.[answer.choice ?? -1] === APPROVAL_OPTION,
    ),
  );
}

function registeredWorktrees(repo) {
  const output = git(repo, ["worktree", "list", "--porcelain"]).stdout;
  return new Set(
    output
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => {
        const path = resolve(line.slice("worktree ".length));
        return existsSync(path) ? realpathSync(path) : path;
      }),
  );
}

function chooseBase(repo) {
  const remotes = git(repo, ["remote"]).stdout.trim().split(/\s+/).filter(Boolean);
  if (remotes.includes("origin")) {
    git(repo, ["fetch", "--quiet", "origin"]);
    for (const name of ["main", "master"]) {
      if (git(repo, ["rev-parse", "--verify", `refs/remotes/origin/${name}`], { allowFailure: true }).status === 0) {
        return `refs/remotes/origin/${name}`;
      }
    }
    throw new Error("远端 origin 没有 main 或 master；未擅自选择其他基准分支");
  }
  for (const name of ["main", "master"]) {
    if (git(repo, ["rev-parse", "--verify", `refs/heads/${name}`], { allowFailure: true }).status === 0) {
      return `refs/heads/${name}`;
    }
  }
  throw new Error("仓库没有 origin/main、origin/master、main 或 master，无法安全创建任务 Worktree");
}

export function ensureWorktree({ repoPath, codexHome, context }) {
  const repo = realpathSync(repoPath);
  const task = taskSlug(context);
  const workspace = join(codexHome, "worktrees", "codex-idea-delivery", task);
  const branch = `codex/${task}`;
  const registered = registeredWorktrees(repo);

  const normalizedWorkspace = existsSync(workspace) ? realpathSync(workspace) : resolve(workspace);
  if (registered.has(normalizedWorkspace)) {
    if (!existsSync(join(workspace, ".git"))) throw new Error("已登记的任务 Worktree 不完整，拒绝重建或覆盖");
    return { workspace, branch, task };
  }
  if (existsSync(workspace)) throw new Error(`任务 Worktree 路径已存在但未登记，拒绝覆盖：${workspace}`);

  mkdirSync(dirname(workspace), { recursive: true });
  const branchExists = git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true }).status === 0;
  if (branchExists) {
    git(repo, ["worktree", "add", workspace, branch]);
  } else {
    git(repo, ["worktree", "add", "--detach", workspace, chooseBase(repo)]);
  }
  return { workspace, branch, task };
}

export function startFeatureBranch(workspace, branch) {
  const current = git(workspace, ["branch", "--show-current"]).stdout.trim();
  if (current === branch) return;
  if (current) throw new Error(`任务 Worktree 当前位于 ${current}，与预期分支 ${branch} 不同`);
  git(workspace, ["switch", "-c", branch]);
}

function codexProgram() {
  return CODEX_PATHS.find(existsSync) ?? "codex";
}

export function codexArgs(turn, writeAccess, writableGitDirs = []) {
  return [
    "exec",
    ...(writeAccess ? writableGitDirs.flatMap((directory) => ["--add-dir", directory]) : []),
    ...(turn.resume ? ["resume", "--all"] : []),
    "--json",
    "--skip-git-repo-check",
    ...(turn.model ? ["-m", turn.model] : []),
    ...(turn.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(turn.effort)}`] : []),
    "-c",
    "features.multi_agent=true",
    "-c",
    `sandbox_mode=${JSON.stringify(writeAccess ? "workspace-write" : "read-only")}`,
    "-c",
    'approval_policy="never"',
    ...(turn.resume ? [turn.resume] : []),
    "-",
  ];
}

function main() {
  const turn = JSON.parse(process.argv[2] ?? "{}");
  const context = JSON.parse(readFileSync(turn.contextFile, "utf8"));
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const { workspace, branch } = ensureWorktree({ repoPath: turn.cwd, codexHome, context });
  const writeAccess = hasImplementationApproval(turn, context);
  if (writeAccess) startFeatureBranch(workspace, branch);
  // Linked Worktrees keep their index/commit metadata in a per-worktree Git dir and refs
  // in the common Git dir. Expose only those two metadata roots after exact task approval.
  const writableGitDirs = writeAccess
    ? [
        git(workspace, ["rev-parse", "--path-format=absolute", "--git-dir"]).stdout.trim(),
        git(workspace, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout.trim(),
      ].map((directory) => realpathSync(directory))
    : [];

  const child = spawn(codexProgram(), codexArgs(turn, writeAccess, writableGitDirs), {
    cwd: workspace,
    env: {
      ...process.env,
      IDEA_DELIVERY_HOME: process.env.IDEA_DELIVERY_HOME ?? resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
    },
    stdio: ["pipe", "inherit", "inherit"],
  });
  child.stdin.end(turn.prompt);
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import adapter from "../plugins/codex-worktree/agent.ts";
import {
  codexArgs,
  ensureWorktree,
  hasImplementationApproval,
  startFeatureBranch,
  taskSlug,
} from "../plugins/codex-worktree/worker.mjs";

test("new tasks are read-only and resume without the incompatible --worktree flag", () => {
  const context = { answers: [] };
  const turn = { prompt: "plan only", resume: null };
  assert.equal(hasImplementationApproval(turn, context), false);
  const first = codexArgs(turn, false);
  assert.ok(first.includes('sandbox_mode="read-only"'));
  assert.ok(first.includes("features.multi_agent=true"));
  assert.ok(!first.includes("--add-dir"));
  assert.ok(!first.includes("--worktree"));

  const resumed = codexArgs({ ...turn, resume: "thread-1" }, false);
  assert.ok(resumed.includes("resume"));
  assert.ok(resumed.includes("--all"));
  assert.ok(!resumed.includes("--worktree"));
  assert.ok(resumed.includes("features.multi_agent=true"));
});

test("Autoloop adapter delegates to its local runner", () => {
  const command = adapter.command({ prompt: "plan only", resume: null, access: "read" });
  assert.equal(command[0], process.execPath);
  assert.match(command[1], /plugins\/codex-worktree\/worker\.mjs$/);
  assert.equal(JSON.parse(command[2]).prompt, "plan only");
});

test("only an exact approval in the resumed task enables Worktree writes", () => {
  const accepted = {
    answers: [{ title: "批准执行计划", options: ["同意，开始实现"], choice: 0 }],
  };
  const rejected = {
    answers: [{ title: "批准执行计划", options: ["同意，开始实现"], choice: 1 }],
  };
  assert.equal(hasImplementationApproval({ resume: "thread-1" }, accepted), true);
  assert.equal(hasImplementationApproval({ resume: "thread-2" }, rejected), false);
  assert.equal(hasImplementationApproval({ resume: null }, accepted), false);
  assert.equal(hasImplementationApproval({ resume: null }, {
    decided: [{ card: 3, title: "批准执行计划", choice: "同意，开始实现" }],
  }), true);
  assert.equal(hasImplementationApproval({ resume: null }, {
    decided: [{ card: 3, title: "批准执行计划", choice: "调整计划" }],
  }), false);
  assert.equal(hasImplementationApproval({ resume: null }, {
    decided: [{ card: 3, title: "其他审批", choice: "同意，开始实现" }],
  }), false);
  assert.ok(codexArgs({ resume: "thread-1" }, true).includes('sandbox_mode="workspace-write"'));
  const writable = codexArgs({ resume: "thread-1" }, true, ["/tmp/repo/.git/worktrees/task", "/tmp/repo/.git"]);
  assert.deepEqual(writable.slice(0, 6), ["exec", "--add-dir", "/tmp/repo/.git/worktrees/task", "--add-dir", "/tmp/repo/.git", "resume"]);
  assert.ok(codexArgs({ resume: "thread-1" }, false, ["/tmp/repo/.git/worktrees/task", "/tmp/repo/.git"]).every((arg) => arg !== "--add-dir" && arg !== "/tmp/repo/.git/worktrees/task" && arg !== "/tmp/repo/.git"));
  assert.ok(codexArgs({ resume: "thread-1" }, false).includes('sandbox_mode="read-only"'));
});

test("event subjects are reduced to a safe task directory name", () => {
  assert.equal(taskSlug({ events: [{ subject: "../../etc/Passwd" }] }), "etc-passwd");
  assert.throws(() => taskSlug({ events: [{ subject: "../../" }] }), /编号/);
});

test("creates and reuses an isolated Git Worktree without touching the original checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-idea-delivery-repo-"));
  const repo = join(root, "repo");
  const codexHome = join(root, "codex-home");
  mkdirSync(repo, { recursive: true });
  const runGit = (...args) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  let workspace;
  try {
    runGit("init", "-b", "main");
    runGit("config", "user.name", "Test User");
    runGit("config", "user.email", "test@example.invalid");
    writeFileSync(join(repo, "README.md"), "baseline\n");
    runGit("add", "README.md");
    runGit("commit", "-m", "baseline");
    const baseline = runGit("rev-parse", "HEAD");
    const context = { events: [{ subject: "idea-demo-123" }] };
    const first = ensureWorktree({ repoPath: repo, codexHome, context });
    workspace = first.workspace;
    assert.match(first.branch, /^codex\/idea-demo-123$/);
    assert.equal(runGit("rev-parse", "HEAD"), baseline);
    assert.equal(runGit("branch", "--show-current"), "main");
    assert.equal(runGit("worktree", "list", "--porcelain").includes(first.workspace), true);
    assert.equal(runGit("-C", first.workspace, "branch", "--show-current"), "");

    writeFileSync(join(first.workspace, "task.txt"), "preserve this task state\n");
    const resumed = ensureWorktree({ repoPath: repo, codexHome, context });
    assert.equal(resumed.workspace, first.workspace);
    assert.equal(runGit("-C", resumed.workspace, "status", "--short"), "?? task.txt");
    startFeatureBranch(resumed.workspace, resumed.branch);
    assert.equal(runGit("-C", resumed.workspace, "branch", "--show-current"), resumed.branch);
    assert.equal(runGit("branch", "--show-current"), "main");
  } finally {
    if (workspace) spawnSync("git", ["worktree", "remove", "--force", workspace], { cwd: repo });
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores inherited Git directory overrides when creating a task Worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-idea-delivery-git-env-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const runGit = (...args) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const previous = process.env.GIT_DIR;
  let workspace;
  try {
    runGit("init", "-b", "main");
    runGit("config", "user.name", "Test User");
    runGit("config", "user.email", "test@example.invalid");
    writeFileSync(join(repo, "README.md"), "baseline\n");
    runGit("add", "README.md");
    runGit("commit", "-m", "baseline");
    process.env.GIT_DIR = join(root, "unrelated-git-dir");
    const result = ensureWorktree({
      repoPath: repo,
      codexHome: join(root, "codex-home"),
      context: { events: [{ subject: "idea-git-env" }] },
    });
    workspace = result.workspace;
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
    assert.equal(spawnSync("git", ["-C", workspace, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).status, 0);
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
    if (workspace) spawnSync("git", ["worktree", "remove", "--force", workspace], { cwd: repo });
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads Codex JSONL into a resumable thread and usage receipt", () => {
  const lines = [
    { type: "thread.started", thread_id: "thread-42" },
    { type: "turn.started" },
    { type: "item.completed", item: { type: "agent_message", text: "计划已整理" } },
    { type: "turn.completed", usage: { input_tokens: 20, output_tokens: 7, cached_input_tokens: 4 } },
  ].map((event) => JSON.stringify(event));
  const result = adapter.read(lines.join("\n"), 0, "");
  assert.equal(result.session, "thread-42");
  assert.equal(result.started, true);
  assert.equal(result.finished, true);
  assert.equal(result.text, "计划已整理");
  assert.deepEqual(result.sessionUsage, { input: 20, output: 7, cached: 4 });
});

test("persists authoritative child thread IDs when a Codex turn completes", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-audit-home-"));
  const sessionDir = join(codexHome, "sessions", "2026", "11", "05");
  const parent = "thread-42";
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, `rollout-2026-11-05T10-28-21-${parent}.jsonl`), JSON.stringify({
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: { type: "SubAgentActivity", kind: "completed", agent_thread_id: "child-99", agent_path: "/root/reviewer" },
    },
  }));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const events = [
      { type: "thread.started", thread_id: parent },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ].map((event) => JSON.stringify(event));
    adapter.read(events.join("\n"), 0, "");
    const auditFile = join(codexHome, "idea-to-delivery", "subagent-audits", `${parent}.json`);
    const audit = JSON.parse(readFileSync(auditFile, "utf8"));
    assert.equal(audit.subagents[0].threadId, "child-99");
    assert.equal(audit.subagents[0].status, "completed");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    rmSync(codexHome, { recursive: true, force: true });
  }
});

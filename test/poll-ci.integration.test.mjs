import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pollerPath = join(projectRoot, "scripts/poll-ci.mjs");

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(t, { provider = "github" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "idea-delivery-ci-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worktree = join(root, "worktrees", "codex-idea-delivery", "task");
  const fakeBin = join(root, "bin");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(fakeBin);
  git(["init", "--initial-branch=codex/idea-1234"], worktree);
  git(["config", "user.name", "CI Test"], worktree);
  git(["config", "user.email", "ci@example.invalid"], worktree);
  writeFileSync(join(worktree, "README.md"), "test\n");
  git(["add", "README.md"], worktree);
  git(["commit", "-m", "test"], worktree);
  git(["remote", "add", "origin", provider === "github" ? "https://github.com/example/project.git" : "https://git.weixin.qq.com/group/project.git"], worktree);
  if (provider === "gitlab") writeFileSync(join(worktree, ".gitlab-ci.yml"), "stages: [test]\n");
  const headSha = git(["rev-parse", "HEAD"], worktree);
  writeFileSync(join(worktree, "task-context.json"), JSON.stringify({
    taskId: "idea-1234",
    repository: { worktree, branch: "codex/idea-1234", ...(provider === "gitlab" ? { provider } : {}) },
  }));

  const ghPath = join(fakeBin, "gh");
  writeFileSync(ghPath, `#!/bin/sh\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi\nif [ "$1" = "run" ] && [ "$2" = "list" ]; then printf '%s' "$MOCK_GH_RUNS"; exit 0; fi\necho 'unexpected gh call' >&2\nexit 2\n`);
  chmodSync(ghPath, 0o755);
  const glabPath = join(fakeBin, "glab");
  writeFileSync(glabPath, `#!/bin/sh\nif [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi\nif [ "$1" = "ci" ] && [ "$2" = "list" ]; then printf '%s' "$MOCK_GH_RUNS"; exit 0; fi\necho 'unexpected glab call' >&2\nexit 2\n`);
  chmodSync(glabPath, 0o755);
  return { root, worktree, headSha };
}

function runPoller(fixtureData, runs, contextPath) {
  return spawnSync(process.execPath, [pollerPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: fixtureData.root,
      PATH: `${join(fixtureData.root, "bin")}:${process.env.PATH}`,
      MOCK_GH_RUNS: JSON.stringify(runs),
      ...(contextPath ? { AGENT_AUTOLOOP_CONTEXT: contextPath } : {}),
    },
  });
}

function eventsFrom(output) {
  const match = output.match(/\n(\{"events":\[.*\]\})\n```/s);
  return match ? JSON.parse(match[1]).events : [];
}

test("poller emits the current-head result in the Autoloop event envelope", (t) => {
  const data = fixture(t);
  const runs = [
    { databaseId: 51, name: "tests", status: "completed", conclusion: "failure", headSha: data.headSha, url: "https://github.com/example/project/actions/runs/51" },
    { databaseId: 52, name: "lint", status: "completed", conclusion: "success", headSha: data.headSha, url: "https://github.com/example/project/actions/runs/52" },
  ];
  const result = runPoller(data, runs);
  assert.equal(result.status, 0, result.stderr);
  const [event] = eventsFrom(result.stdout);
  assert.equal(event.type, "ci.failed");
  assert.equal(event.subject, "idea-1234");
  assert.equal(event.id, `github-ci-failed-${data.headSha}`);
  assert.equal(JSON.parse(event.detail).repairExhausted, false);
});

test("poller waits for in-progress workflows and ignores unrelated branch metadata", (t) => {
  const data = fixture(t);
  const pending = runPoller(data, [
    { databaseId: 53, name: "tests", status: "completed", conclusion: "success", headSha: data.headSha, url: "https://github.com/example/project/actions/runs/53" },
    { databaseId: 54, name: "lint", status: "in_progress", conclusion: null, headSha: data.headSha, url: "https://github.com/example/project/actions/runs/54" },
  ]);
  assert.equal(pending.status, 0, pending.stderr);
  assert.deepEqual(eventsFrom(pending.stdout), []);

  const contextPath = join(data.worktree, "task-context.json");
  writeFileSync(contextPath, JSON.stringify({ taskId: "idea-1234", repository: { worktree: data.worktree, branch: "codex/another-task" } }));
  const unrelated = runPoller(data, [{ databaseId: 55, name: "tests", status: "completed", conclusion: "failure", headSha: data.headSha }]);
  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.deepEqual(eventsFrom(unrelated.stdout), []);
});

test("poller emits GitLab pipeline results for a self-managed host", (t) => {
  const data = fixture(t, { provider: "gitlab" });
  const result = runPoller(data, [{
    id: 66,
    name: "test pipeline",
    status: "failed",
    sha: data.headSha,
    web_url: "https://git.weixin.qq.com/group/project/-/pipelines/66",
  }]);
  assert.equal(result.status, 0, result.stderr);
  const [event] = eventsFrom(result.stdout);
  assert.equal(event.type, "ci.failed");
  assert.equal(event.subject, "idea-1234");
  assert.equal(event.link, "https://git.weixin.qq.com/group/project/-/pipelines/66");
});

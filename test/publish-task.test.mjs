import test from "node:test";
import assert from "node:assert/strict";
import { publishTask } from "../scripts/publish-task.mjs";

const context = {
  taskId: "idea-1234",
  repository: { path: "/tmp/source-repository", worktree: "/tmp/task-worktree", branch: "codex/idea-1234" },
};

function fakeRunner({ remote = "https://github.com/example/project.git", dirty = "", refs = "abc refs/heads/main", ahead = "1", existing = "[]", existingMR = "[]" } = {}) {
  const calls = [];
  const run = async (bin, args, cwd) => {
    calls.push([bin, args, cwd]);
    const key = `${bin} ${args.join(" ")}`;
    if (key === "git rev-parse --show-toplevel") return cwd;
    if (key === "git rev-parse --path-format=absolute --git-common-dir") {
      return cwd === "/tmp/source-repository" ? "/tmp/source-repository/.git" : cwd === "/tmp/other-repository" ? "/tmp/other-repository/.git" : "/tmp/source-repository/.git";
    }
    if (key === "git branch --show-current") return "codex/idea-1234";
    if (key === "git status --porcelain") return dirty;
    if (key === "git remote") return remote ? "origin" : "";
    if (key === "git remote get-url origin") return remote;
    if (key === "git ls-remote --heads origin main master") return refs;
    if (key === "git rev-list --count origin/main..HEAD") return ahead;
    if (bin === "gh" && key.startsWith("gh pr list ")) return existing;
    if (bin === "gh" && key.startsWith("gh pr create ")) return "https://github.com/example/project/pull/7";
    if (bin === "glab" && key === "glab mr list --source-branch codex/idea-1234 --target-branch main --output json --per-page 1") return existingMR;
    if (bin === "glab" && key === "glab mr create --target-branch main --source-branch codex/idea-1234 --fill --push=false --yes") return "https://git.weixin.qq.com/group/project/-/merge_requests/7";
    return "";
  };
  return { run, calls };
}

test("pushes a clean task branch and opens a PR against main without merging", async () => {
  const { run, calls } = fakeRunner();
  const result = await publishTask({ context, cwd: "/tmp/task-worktree", run });
  assert.deepEqual(result, {
    published: true,
    provider: "github",
    branch: "codex/idea-1234",
    base: "main",
    url: "https://github.com/example/project/pull/7",
    reused: false,
  });
  assert.ok(calls.some(([bin, args]) => bin === "git" && args[0] === "push"));
  assert.ok(calls.some(([bin, args]) => bin === "gh" && args[0] === "pr" && args[1] === "create"));
  assert.ok(!calls.some(([bin, args]) => bin === "gh" && args.includes("merge")));
});

test("pushes new commits and reuses an existing PR", async () => {
  const { run, calls } = fakeRunner({ existing: '[{"url":"https://github.com/example/project/pull/4","baseRefName":"main"}]' });
  const result = await publishTask({ context, cwd: "/tmp/task-worktree", run });
  assert.equal(result.reused, true);
  assert.equal(result.provider, "github");
  assert.equal(result.url, "https://github.com/example/project/pull/4");
  assert.ok(calls.some(([bin, args]) => bin === "git" && args[0] === "push"));
  assert.ok(!calls.some(([bin, args]) => bin === "gh" && args[1] === "create"));
});

test("creates or reuses a GitLab MR without asking glab to push or merge", async () => {
  const gitlabContext = {
    ...context,
    repository: { ...context.repository, provider: "gitlab" },
  };
  const remote = "git@git.weixin.qq.com:group/project.git";
  const { run, calls } = fakeRunner({ remote });
  const result = await publishTask({ context: gitlabContext, cwd: "/tmp/task-worktree", run });
  assert.deepEqual(result, {
    published: true,
    provider: "gitlab",
    branch: "codex/idea-1234",
    base: "main",
    url: "https://git.weixin.qq.com/group/project/-/merge_requests/7",
    reused: false,
  });
  assert.ok(calls.some(([bin, args]) => bin === "glab" && args[0] === "auth"));
  assert.ok(calls.some(([bin, args]) => bin === "glab" && args[0] === "mr" && args[1] === "create" && args.includes("--push=false")));
  assert.ok(!calls.some(([, args]) => args.includes("merge")));

  const existingMR = fakeRunner({ remote, existingMR: '[{"web_url":"https://git.weixin.qq.com/group/project/-/merge_requests/6","target_branch":"main"}]' });
  const reused = await publishTask({ context: gitlabContext, cwd: "/tmp/task-worktree", run: existingMR.run });
  assert.equal(reused.reused, true);
  assert.equal(reused.url, "https://git.weixin.qq.com/group/project/-/merge_requests/6");
});

test("does not publish when origin is missing", async () => {
  const { run, calls } = fakeRunner({ remote: "" });
  const result = await publishTask({ context, cwd: "/tmp/task-worktree", run });
  assert.deepEqual(result, { published: false, reason: "仓库没有 origin 远端；保留本地任务分支" });
  assert.ok(!calls.some(([bin, args]) => bin === "git" && args[0] === "push"));
});

test("rejects dirty worktrees and branches belonging to another task before side effects", async () => {
  const dirty = fakeRunner({ dirty: " M src/app.js" });
  await assert.rejects(publishTask({ context, cwd: "/tmp/task-worktree", run: dirty.run }), /未提交改动/);
  assert.equal(dirty.calls.some(([bin, args]) => bin === "git" && args[0] === "push"), false);

  const wrongBranch = fakeRunner();
  const run = async (bin, args, cwd) => args[0] === "branch" ? "main" : wrongBranch.run(bin, args, cwd);
  await assert.rejects(publishTask({ context, cwd: "/tmp/task-worktree", run }), /拒绝发布非当前任务分支/);

  const mismatchedContext = { ...context, repository: { ...context.repository, branch: "codex/idea-other" } };
  await assert.rejects(publishTask({ context: mismatchedContext, cwd: "/tmp/task-worktree", run: wrongBranch.run }), /要求 codex\/idea-1234/);
});

test("rejects a task Worktree attached to a different repository before side effects", async () => {
  const { run, calls } = fakeRunner();
  const mismatched = {
    ...context,
    repository: { ...context.repository, path: "/tmp/other-repository" },
  };
  await assert.rejects(
    publishTask({ context: mismatched, cwd: "/tmp/task-worktree", run }),
    /不属于同一个 Git 仓库/,
  );
  assert.equal(calls.some(([bin, args]) => bin === "git" && args[0] === "push"), false);
});

test("requires a known base branch and a branch ahead of it", async () => {
  await assert.rejects(
    publishTask({ context, cwd: "/tmp/task-worktree", run: fakeRunner({ refs: "" }).run }),
    /不存在 main 或 master/,
  );
  await assert.rejects(
    publishTask({ context, cwd: "/tmp/task-worktree", run: fakeRunner({ ahead: "0" }).run }),
    /没有领先基准分支/,
  );
  await assert.rejects(
    publishTask({ context, cwd: "/tmp/task-worktree", run: fakeRunner({ existing: '[{"url":"https://github.com/example/project/pull/4","baseRefName":"develop"}]' }).run }),
    /现有 PR\/MR 的基准是 develop/,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { publishTask } from "../scripts/publish-task.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("pushes a task branch to a disposable Git remote before creating a mocked PR", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "idea-delivery-publish-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "origin.git");
  const seed = join(root, "seed");
  const worktree = join(root, "worktree");
  mkdirSync(seed);
  git(["init", "--bare", "--initial-branch=main", remote], root);
  git(["init", "--initial-branch=main"], seed);
  git(["config", "user.name", "Test User"], seed);
  git(["config", "user.email", "test@example.invalid"], seed);
  writeFileSync(join(seed, "README.md"), "base\n");
  git(["add", "README.md"], seed);
  git(["commit", "-m", "base"], seed);
  git(["remote", "add", "origin", remote], seed);
  git(["push", "origin", "main"], seed);
  git(["clone", remote, worktree], root);
  git(["config", "user.name", "Test User"], worktree);
  git(["config", "user.email", "test@example.invalid"], worktree);
  git(["config", `url.${pathToFileURL(remote).href}.insteadOf`, "https://github.com/example/project.git"], worktree);
  git(["remote", "set-url", "origin", "https://github.com/example/project.git"], worktree);
  git(["switch", "-c", "codex/idea-1234"], worktree);
  writeFileSync(join(worktree, "feature.txt"), "delivered\n");
  git(["add", "feature.txt"], worktree);
  git(["commit", "-m", "Add delivered feature"], worktree);
  writeFileSync(join(worktree, "PROGRESS.md"), "Local task state\n");
  writeFileSync(join(worktree, "BLOCKED.md"), "No blockers\n");
  writeFileSync(join(worktree, "task-context.json"), "{}\n");

  const ghCalls = [];
  const run = (bin, args, cwd) => {
    if (bin === "git" && args.join(" ") === "remote get-url origin") return "https://github.com/example/project.git";
    if (bin === "gh") {
      ghCalls.push(args);
      if (args.join(" ") === "auth status") return "Logged in (mock)";
      if (args.join(" ") === "pr list --head codex/idea-1234 --json url,baseRefName --limit 1") return "[]";
      if (args.join(" ") === "pr create --base main --head codex/idea-1234 --fill") return "https://github.com/example/project/pull/9";
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    }
    const result = spawnSync(bin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error((result.stderr || result.stdout).trim());
    return result.stdout.trim();
  };

  const result = await publishTask({
    cwd: worktree,
    run,
    context: { taskId: "idea-1234", repository: { path: worktree, worktree, branch: "codex/idea-1234" } },
  });
  assert.deepEqual(result, {
    published: true,
    provider: "github",
    branch: "codex/idea-1234",
    base: "main",
    url: "https://github.com/example/project/pull/9",
    reused: false,
  });
  assert.equal(git(["--git-dir", remote, "rev-parse", "refs/heads/codex/idea-1234"], root), git(["rev-parse", "HEAD"], worktree));
  assert.deepEqual(ghCalls.map((args) => args.at(-1)), ["status", "1", "--fill"]);
});

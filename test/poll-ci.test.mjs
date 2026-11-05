import test from "node:test";
import assert from "node:assert/strict";
import { classifyCurrentCommit, failedCommitCount, makeCIEvent, normalizeGitLabPipelines, resolveProvider } from "../scripts/poll-ci.mjs";

test("waits for every workflow on the current commit before emitting a CI event", () => {
  const runs = [
    { headSha: "sha-1", status: "completed", conclusion: "success" },
    { headSha: "sha-1", status: "in_progress", conclusion: null },
  ];
  assert.equal(classifyCurrentCommit(runs, "sha-1"), null);
  assert.equal(makeCIEvent({ taskId: "idea-123", headSha: "sha-1", runs }), null);
});

test("counts distinct failed commits and sends a bounded failure event back to the task", () => {
  const runs = [
    { databaseId: 11, headSha: "sha-1", status: "completed", conclusion: "failure", name: "test", url: "https://github.test/runs/11" },
    { databaseId: 12, headSha: "sha-1", status: "completed", conclusion: "failure", name: "lint", url: "https://github.test/runs/12" },
    { databaseId: 13, headSha: "sha-2", status: "completed", conclusion: "success", name: "test", url: "https://github.test/runs/13" },
    { databaseId: 14, headSha: "sha-3", status: "completed", conclusion: "failure", name: "test", url: "https://github.test/runs/14" },
  ];
  assert.equal(failedCommitCount(runs), 2);
  assert.equal(classifyCurrentCommit(runs, "sha-3"), "failed");
  assert.deepEqual(makeCIEvent({ taskId: "idea-123", headSha: "sha-3", runs }), {
    id: "github-ci-failed-sha-3",
    type: "ci.failed",
    subject: "idea-123",
    summary: "GitHub CI 未通过：已修复 1 轮，最多 2 轮",
    detail: JSON.stringify({
      taskId: "idea-123",
      headSha: "sha-3",
      failedCommits: 2,
      repairAttempt: 1,
      repairLimit: 2,
      repairExhausted: false,
      runs: [{ databaseId: 14, name: "test", conclusion: "failure", url: "https://github.test/runs/14" }],
    }),
    link: "https://github.test/runs/14",
    hops: 0,
  });
});

test("marks the third distinct failed commit exhausted so the router must request a decision", () => {
  const runs = ["sha-1", "sha-2", "sha-3"].map((headSha, index) => ({
    databaseId: index + 1,
    headSha,
    status: "completed",
    conclusion: "failure",
    name: "test",
    url: `https://github.test/runs/${index + 1}`,
  }));
  const event = makeCIEvent({ taskId: "idea-123", headSha: "sha-3", runs, repairLimit: 2 });
  assert.equal(event.summary, "GitHub CI 再次失败：已用尽 2 轮自动修复");
  assert.deepEqual(JSON.parse(event.detail), {
    taskId: "idea-123",
    headSha: "sha-3",
    failedCommits: 3,
    repairAttempt: 2,
    repairLimit: 2,
    repairExhausted: true,
    runs: [{ databaseId: 3, name: "test", conclusion: "failure", url: "https://github.test/runs/3" }],
  });
});

test("emits a pass event only for an all-green commit", () => {
  const event = makeCIEvent({
    taskId: "idea-123",
    headSha: "sha-1",
    runs: [{ databaseId: 21, headSha: "sha-1", status: "completed", conclusion: "success", name: "test", url: "https://github.test/runs/21" }],
  });
  assert.equal(event.type, "ci.passed");
  assert.equal(event.subject, "idea-123");
});

test("does not emit CI events for a different current head", () => {
  const event = makeCIEvent({
    taskId: "idea-123",
    headSha: "sha-current",
    runs: [{ databaseId: 22, headSha: "sha-old", status: "completed", conclusion: "failure", name: "test", url: "https://github.test/runs/22" }],
  });
  assert.equal(event, null);
});

test("normalizes GitLab pipeline states for the shared CI retry policy", () => {
  const runs = normalizeGitLabPipelines([
    { id: 1, name: "test", status: "success", sha: "sha-1", web_url: "https://gitlab.example/pipelines/1" },
    { id: 2, name: "lint", status: "failed", sha: "sha-2", web_url: "https://gitlab.example/pipelines/2" },
    { id: 3, name: "pending", status: "running", sha: "sha-3", web_url: "https://gitlab.example/pipelines/3" },
  ]);
  assert.equal(runs[0].conclusion, "success");
  assert.equal(runs[1].conclusion, "failure");
  assert.equal(runs[2].status, "in_progress");
});

test("infers GitHub and GitLab hosts and requires an explicit provider for ambiguous remotes", () => {
  assert.equal(resolveProvider({ remote: "https://github.com/acme/app.git", context: { repository: {} }, worktree: "/tmp" }).provider, "github");
  assert.equal(resolveProvider({ remote: "git@gitlab.example:acme/app.git", context: { repository: {} }, worktree: "/tmp" }).provider, "gitlab");
  assert.equal(resolveProvider({ remote: "https://code.example/acme/app.git", context: { repository: {} }, worktree: "/tmp" }), null);
});

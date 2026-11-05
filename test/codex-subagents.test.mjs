import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditSubagents, findRolloutFile, persistSubagentAudit, readSubagentsFromRollout } from "../plugins/codex-worktree/subagent-audit.mjs";

test("reads authoritative subagent lifecycle events without reading agent prompt or output", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-rollout-"));
  const parent = "01a1a989-296f-7230-8359-da77b93ab7ac";
  const dir = join(home, "sessions", "2026", "11", "05");
  const rollout = join(dir, `rollout-2026-11-05T10-28-21-${parent}.jsonl`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(rollout, [
    JSON.stringify({ type: "response_item", payload: { type: "function_call", namespace: "collaboration", name: "spawn_agent", arguments: "private prompt" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "SubAgentActivity", kind: "started", agent_thread_id: "child-1", agent_path: "/root/backend" } } }),
    "malformed line",
    JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "SubAgentActivity", kind: "completed", agent_thread_id: "child-1", agent_path: "/root/backend" } } }),
    JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "SubAgentActivity", kind: "started", agent_thread_id: "child-2", agent_path: "/root/reviewer" } } }),
  ].join("\n"));

  try {
    assert.equal(findRolloutFile(home, parent), rollout);
    assert.deepEqual(readSubagentsFromRollout(rollout), [
      { threadId: "child-1", agentPath: "/root/backend", status: "completed" },
      { threadId: "child-2", agentPath: "/root/reviewer", status: "started" },
    ]);
    assert.deepEqual(auditSubagents(parent, home).subagents, readSubagentsFromRollout(rollout));
    const destination = persistSubagentAudit(home, auditSubagents(parent, home));
    const saved = JSON.parse(readFileSync(destination, "utf8"));
    assert.equal(saved.parentThreadId, parent);
    assert.equal(saved.subagents.length, 2);
    assert.ok(saved.recordedAt);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rejects malformed parent ids and missing rollout logs", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-rollout-empty-"));
  try {
    assert.throws(() => auditSubagents("../secrets", home), /有效的 Codex 主会话 ID/);
    assert.throws(() => auditSubagents("01a1a989-296f-7230-8359-da77b93ab7ac", home), /找不到主会话/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

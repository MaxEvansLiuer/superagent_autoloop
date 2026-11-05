import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function findRollouts(sessions, target, depth = 0, found = []) {
  let entries;
  try { entries = readdirSync(sessions, { withFileTypes: true }); }
  catch { return found; }
  for (const entry of entries) {
    const path = join(sessions, entry.name);
    if (entry.isFile() && entry.name.includes(target) && entry.name.endsWith(".jsonl")) found.push(path);
    else if (entry.isDirectory() && depth < 3) findRollouts(path, target, depth + 1, found);
  }
  return found;
}
export function findRolloutFile(codexHome, parentThreadId) {
  const matches = findRollouts(join(codexHome, "sessions"), parentThreadId)
    .map((path) => ({ path, modified: statSync(path).mtimeMs }))
    .sort((a, b) => b.modified - a.modified);
  return matches[0]?.path;
}

export function readSubagentsFromRollout(rolloutPath) {
  const agents = new Map();
  for (const line of readFileSync(rolloutPath, "utf8").split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const item = event.type === "event_msg" && event.payload?.type === "item_completed"
      ? event.payload.item
      : null;
    if (item?.type !== "SubAgentActivity" || !item.agent_thread_id) continue;
    const previous = agents.get(item.agent_thread_id) ?? {};
    agents.set(item.agent_thread_id, {
      threadId: item.agent_thread_id,
      agentPath: item.agent_path ?? previous.agentPath ?? null,
      status: item.kind === "completed" ? "completed" : item.kind === "started" ? "started" : previous.status ?? "unknown",
    });
  }
  return [...agents.values()];
}

export function auditSubagents(parentThreadId, codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")) {
  if (!parentThreadId || !/^[a-f0-9-]{20,}$/i.test(parentThreadId)) throw new Error("请提供有效的 Codex 主会话 ID");
  const rolloutPath = findRolloutFile(resolve(codexHome), parentThreadId);
  if (!rolloutPath) throw new Error(`找不到主会话 ${parentThreadId} 的 Codex rollout 日志`);
  return { parentThreadId, rolloutPath, subagents: readSubagentsFromRollout(rolloutPath) };
}

export function persistSubagentAudit(codexHome, audit) {
  const directory = join(codexHome, "idea-to-delivery", "subagent-audits");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, `${audit.parentThreadId}.json`);
  const temporary = `${destination}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...audit, recordedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, destination);
  return destination;
}

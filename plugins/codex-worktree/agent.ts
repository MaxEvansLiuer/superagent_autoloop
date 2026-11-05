import { join } from "node:path";
import { homedir } from "node:os";
import { findRolloutFile, readSubagentsFromRollout, persistSubagentAudit } from "./subagent-audit.mjs";

function persistAudit(parentThreadId: string) {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const rolloutPath = findRolloutFile(codexHome, parentThreadId);
  if (!rolloutPath) return;
  const subagents = readSubagentsFromRollout(rolloutPath);
  persistSubagentAudit(codexHome, { parentThreadId, rolloutPath, subagents });
}

export default {
  command(turn: object) {
    return [process.execPath, join(import.meta.dirname, "worker.mjs"), JSON.stringify(turn)];
  },

  read(stdout: string, code: number | null, stderr: string) {
    const reading: {
      text?: string;
      session?: string;
      sessionUsage?: { input: number; output: number; cached: number };
      error?: string;
      finished?: boolean;
      started?: boolean;
      completed?: boolean;
    } = {};

    for (const line of stdout.split("\n")) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!event) continue;
      if (event.type === "thread.started") reading.session = event.thread_id;
      else if (event.type === "turn.started") reading.started = true;
      else if (event.type === "item.completed" && event.item?.type === "agent_message") reading.text = event.item.text;
      else if (event.type === "turn.completed") {
        reading.completed = reading.finished = true;
        const usage = event.usage ?? {};
        reading.sessionUsage = {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cached: usage.cached_input_tokens ?? 0,
        };
        if (reading.session) {
          try { persistAudit(reading.session); } catch { /* Keep the agent result usable if audit storage is unavailable. */ }
        }
      } else if (event.type === "turn.failed") {
        reading.finished = true;
        reading.error = event.error?.message ?? "Codex 没跑完这一轮";
      } else if (event.type === "error") reading.error = event.message;
    }

    const { completed, ...result } = reading;
    if (!completed) delete result.text;
    if (code !== null && !completed && !result.error) result.error = stderr.trim().slice(-300) || "Codex 没有完成这一轮";
    if (completed && !result.text?.trim()) result.error = "Codex 完成了，但没有留下最终回复";
    return result;
  },

  link(session: string) {
    return `codex://threads/${session}`;
  },

  check() {
    return null;
  },
};

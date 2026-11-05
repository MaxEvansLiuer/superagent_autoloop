import { auditSubagents } from "../plugins/codex-worktree/subagent-audit.mjs";

try {
  const result = auditSubagents(process.argv[2], process.env.CODEX_HOME);
  console.log(JSON.stringify(result, null, 2));
  if (result.subagents.length === 0) process.exitCode = 1;
} catch (error) {
  console.error(`子 Agent 审计失败：${error.message}`);
  console.error("用法：node scripts/codex-subagents.mjs <Codex 主会话 ID>");
  process.exitCode = 2;
}

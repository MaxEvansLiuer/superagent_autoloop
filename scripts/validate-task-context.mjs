import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(resolve(root, "schemas/task-context.schema.json"), "utf8"));

function fail(message) {
  console.error(`任务上下文无效：${message}`);
  process.exitCode = 1;
}

function validate(value) {
  const issues = [];
  const object = (item) => item !== null && typeof item === "object" && !Array.isArray(item);
  const hasText = (item) => typeof item === "string" && item.trim().length > 0;
  if (!object(value)) return ["根节点必须是对象"];

  for (const key of schema.required) if (!(key in value)) issues.push(`缺少 ${key}`);
  for (const key of Object.keys(value)) if (!schema.properties[key]) issues.push(`不允许字段 ${key}`);
  if (value.version !== 1) issues.push("version 必须为 1");
  for (const key of ["taskId", "goal"]) if (!hasText(value[key])) issues.push(`${key} 必须是非空字符串`);
  for (const key of ["nonGoals", "approvedScope", "acceptanceChecks"]) {
    if (!Array.isArray(value[key]) || value[key].some((item) => !hasText(item))) issues.push(`${key} 必须是字符串数组`);
  }
  for (const key of ["approvedScope", "acceptanceChecks"]) if (Array.isArray(value[key]) && value[key].length === 0) issues.push(`${key} 不能为空`);

  if (!object(value.baseline)) issues.push("baseline 必须是对象");
  else {
    for (const key of Object.keys(value.baseline)) if (!["commit", "facts", "checks"].includes(key)) issues.push(`baseline 不允许字段 ${key}`);
    for (const key of ["commit"]) if (!hasText(value.baseline[key])) issues.push(`baseline.${key} 必须是非空字符串`);
    for (const key of ["facts", "checks"]) if (!Array.isArray(value.baseline[key]) || value.baseline[key].some((item) => typeof item !== "string")) issues.push(`baseline.${key} 必须是字符串数组`);
  }

  if (!object(value.repository)) issues.push("repository 必须是对象");
  else {
    for (const key of Object.keys(value.repository)) if (!["path", "worktree", "branch", "provider"].includes(key)) issues.push(`repository 不允许字段 ${key}`);
    for (const key of ["path", "worktree", "branch"]) if (!hasText(value.repository[key])) issues.push(`repository.${key} 必须是非空字符串`);
    if (value.repository.provider !== undefined && !["github", "gitlab"].includes(value.repository.provider)) issues.push("repository.provider 必须是 github 或 gitlab");
  }

  const workers = value.workers;
  if (!Array.isArray(workers) || workers.length > 3) issues.push("workers 必须是最多 3 项的数组");
  else {
    const ids = new Set();
    const entries = [];
    for (const [index, worker] of workers.entries()) {
      const label = `workers[${index}]`;
      if (!object(worker)) { issues.push(`${label} 必须是对象`); continue; }
      for (const key of schema.properties.workers.items.required) if (!(key in worker)) issues.push(`${label} 缺少 ${key}`);
      for (const key of Object.keys(worker)) if (!schema.properties.workers.items.properties[key]) issues.push(`${label} 不允许字段 ${key}`);
      for (const key of ["id", "role", "assignment"]) if (!hasText(worker[key])) issues.push(`${label}.${key} 必须是非空字符串`);
      if (hasText(worker.id)) {
        if (ids.has(worker.id)) issues.push(`Worker id 重复：${worker.id}`);
        ids.add(worker.id);
      }
      for (const key of ["fileAllowlist", "dependsOn", "interfaces", "deliverables"]) {
        if (!Array.isArray(worker[key]) || worker[key].some((item) => typeof item !== "string" || (key !== "interfaces" && !item.trim()))) issues.push(`${label}.${key} 必须是字符串数组`);
      }
      if (Array.isArray(worker.fileAllowlist)) {
        if (!worker.fileAllowlist.length) issues.push(`${label}.fileAllowlist 不能为空`);
        for (const raw of worker.fileAllowlist) {
          if (!hasText(raw) || raw.startsWith("/") || raw.split(/[\\/]/).includes("..")) {
            issues.push(`${label}.fileAllowlist 包含不安全路径：${raw}`);
            continue;
          }
          const path = raw.replaceAll("\\", "/").replace(/\/$/, "");
          entries.push({ workerId: worker.id, path });
        }
      }
      if (Array.isArray(worker.deliverables) && worker.deliverables.length === 0) issues.push(`${label}.deliverables 不能为空`);
    }
    for (const worker of workers.filter(object)) {
      if (Array.isArray(worker.dependsOn)) for (const dependency of worker.dependsOn) if (!ids.has(dependency)) issues.push(`Worker ${worker.id} 依赖不存在的 Worker：${dependency}`);
    }
    const workerById = new Map(workers.filter(object).map((worker) => [worker.id, worker]));
    const visiting = new Set();
    const visited = new Set();
    function visit(id) {
      if (visiting.has(id)) { issues.push(`Worker 依赖形成循环：${[...visiting, id].join(" → ")}`); return; }
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of workerById.get(id)?.dependsOn ?? []) if (workerById.has(dependency)) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    }
    for (const id of workerById.keys()) visit(id);
    for (let i = 0; i < entries.length; i += 1) for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i];
      const b = entries[j];
      if (a.workerId !== b.workerId && (a.path === b.path || a.path.startsWith(`${b.path}/`) || b.path.startsWith(`${a.path}/`))) {
        issues.push(`Worker 文件范围冲突：${a.workerId}:${a.path} 与 ${b.workerId}:${b.path}`);
      }
    }
  }

  if (!object(value.decisionGates)) issues.push("decisionGates 必须是对象");
  else {
    for (const key of Object.keys(value.decisionGates)) if (!["notifyUserWhen", "autoRouteWhen"].includes(key)) issues.push(`decisionGates 不允许字段 ${key}`);
    for (const key of ["notifyUserWhen", "autoRouteWhen"]) if (!Array.isArray(value.decisionGates[key]) || value.decisionGates[key].some((item) => !hasText(item))) issues.push(`decisionGates.${key} 必须是字符串数组`);
  }
  return issues;
}

const path = process.argv[2];
if (!path) {
  console.error("用法：node scripts/validate-task-context.mjs <task-context.json>");
  process.exit(2);
}

try {
  const context = JSON.parse(readFileSync(resolve(path), "utf8"));
  const issues = validate(context);
  if (issues.length) for (const issue of issues) fail(issue);
  else console.log(`任务上下文有效：${context.taskId}；Workers=${context.workers.length}`);
} catch (error) {
  console.error(`无法读取任务上下文：${error.message}`);
  process.exitCode = 1;
}

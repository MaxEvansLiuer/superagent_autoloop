import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export const EVENT_KINDS = ["idea.created", "task.continue", "review.finding", "ci.failed", "ci.passed"];

export function registryPath(autoHome) {
  return join(autoHome, "projects.json");
}

export function readProjects(autoHome) {
  const file = registryPath(autoHome);
  if (!existsSync(file)) throw new Error(`项目尚未登记：${file}`);
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (value.version !== 1 || !Array.isArray(value.projects) || value.projects.length < 1) {
    throw new Error("项目登记文件必须包含至少一个项目");
  }
  const ids = new Set();
  const paths = new Set();
  for (const project of value.projects) {
    if (!/^[a-z][a-z0-9]{0,31}$/.test(project.id) || ids.has(project.id)) throw new Error(`项目编号无效或重复：${project.id}`);
    if (typeof project.name !== "string" || !project.name.trim()) throw new Error(`项目 ${project.id} 缺少显示名称`);
    if (typeof project.path !== "string" || !project.path.startsWith("/")) throw new Error(`项目 ${project.id} 必须使用绝对路径`);
    const path = resolve(project.path);
    if (paths.has(path)) throw new Error(`同一个仓库不能登记两次：${path}`);
    ids.add(project.id);
    paths.add(path);
  }
  return value.projects;
}

export function projectById(projects, id) {
  const project = projects.find((item) => item.id === id);
  if (!project) throw new Error(`未登记项目 ${id || ""}；请用 scripts/projects.mjs list 查看`);
  return project;
}

export function projectIdFromEventType(type) {
  const match = /^(?:idea|task|review|ci)\.([a-z][a-z0-9]{0,31})\.(?:created|continue|finding|failed|passed)$/.exec(type);
  return match?.[1] ?? null;
}

export function projectIdForTask(projects, taskId, codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")) {
  const prefix = /^idea-([a-z][a-z0-9]{0,31})-/i.exec(taskId);
  if (prefix && projects.some((project) => project.id === prefix[1])) return prefix[1];
  if (projects.length === 1) return projects[0].id;

  const worktrees = join(codexHome, "worktrees", "codex-idea-delivery");
  if (existsSync(worktrees)) {
    for (const entry of readdirSync(worktrees)) {
      const contextPath = join(worktrees, entry, "task-context.json");
      if (!existsSync(contextPath)) continue;
      try {
        const context = JSON.parse(readFileSync(contextPath, "utf8"));
        if (context.taskId !== taskId) continue;
        if (context.projectId && projects.some((project) => project.id === context.projectId)) return context.projectId;
        const repositoryPath = resolve(context.repository?.path || "");
        const project = projects.find((item) => resolve(item.path) === repositoryPath);
        if (project) return project.id;
      } catch {}
    }
  }
  throw new Error(`无法将任务 ${taskId} 安全映射到一个已登记项目`);
}


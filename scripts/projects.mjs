#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { projectById, readProjects, registryPath } from "./project-registry.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const autoHome = join(root, ".local/agent-autoloop");
const file = registryPath(autoHome);
const [action, ...args] = process.argv.slice(2);

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { cwd: root, encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(" ")} 执行失败`);
}

function printProjects(projects) {
  for (const project of projects) console.log(`${project.id}\t${project.name}\t${project.path}`);
}

if (action === "list") {
  printProjects(readProjects(autoHome));
} else if (action === "resolve") {
  const projects = readProjects(autoHome);
  const requested = args[0] || (projects.length === 1 ? projects[0].id : "");
  if (!requested) throw new Error("当前登记了多个项目，请显式指定项目编号");
  console.log(projectById(projects, requested).id);
} else if (action === "for-task") {
  if (!args[0]) throw new Error("用法：scripts/projects.mjs for-task <task-id>");
  const { projectIdForTask } = await import("./project-registry.mjs");
  console.log(projectIdForTask(readProjects(autoHome), args[0]));
} else if (action === "add") {
  if (!existsSync(file)) run(process.execPath, [join(root, "scripts/configure-demo.mjs")]);
  const [id, inputPath, ...nameParts] = args;
  if (!/^[a-z][a-z0-9]{0,31}$/.test(id || "")) throw new Error("项目编号只能用小写字母开头，后跟小写字母或数字，最多 32 位");
  if (!inputPath || !inputPath.startsWith("/")) throw new Error("请提供仓库的绝对路径");
  const path = realpathSync(inputPath);
  const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: path, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (gitRoot.status !== 0 || realpathSync(gitRoot.stdout.trim()) !== path) throw new Error("路径必须是一个 Git 仓库根目录");
  const name = nameParts.join(" ").trim() || id;
  const projects = readProjects(autoHome);
  if (projects.some((project) => project.id === id)) throw new Error(`项目编号 ${id} 已存在`);
  if (projects.some((project) => realpathSync(project.path) === path)) throw new Error(`仓库已登记：${path}`);
  const previous = readFileSync(file);
  writeFileSync(file, `${JSON.stringify({ version: 1, projects: [...projects, { id, name, path }] }, null, 2)}\n`, { mode: 0o600 });
  try {
    run(process.execPath, [join(root, "scripts/configure-demo.mjs")]);
    run(join(root, "scripts/agent-autoloop.sh"), ["check"]);
  } catch (error) {
    writeFileSync(file, previous, { mode: 0o600 });
    try { run(process.execPath, [join(root, "scripts/configure-demo.mjs")]); } catch {}
    throw error;
  }
  const concurrency = Math.max(4, projects.length + 1);
  console.log(`已登记 ${id}；当前登记 ${projects.length + 1} 个项目，同时任务容量为 ${concurrency}，随项目数量增长。`);
  printProjects(readProjects(autoHome));
} else {
  console.error("用法：scripts/projects.mjs list | add <id> <绝对仓库路径> [项目名称] | resolve [id] | for-task <task-id>");
  process.exitCode = 2;
}

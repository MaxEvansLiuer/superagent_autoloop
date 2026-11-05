import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = resolve(import.meta.dirname, "..");
const validator = join(repo, "scripts/validate-task-context.mjs");
const example = JSON.parse(readFileSync(join(repo, "templates/task-context.example.json"), "utf8"));

function validate(context) {
  const dir = mkdtempSync(join(tmpdir(), "task-context-"));
  const file = join(dir, "context.json");
  try {
    writeFileSync(file, JSON.stringify(context));
    return spawnSync(process.execPath, [validator, file], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("accepts task context with explicit user gates and disjoint worker scopes", () => {
  const result = validate(example);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Workers=2/);
});

test("accepts an explicit GitLab provider and rejects unsupported providers", () => {
  const context = structuredClone(example);
  context.repository.provider = "gitlab";
  assert.equal(validate(context).status, 0);
  context.repository.provider = "bitbucket";
  const result = validate(context);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /repository.provider 必须是 github 或 gitlab/);
});

test("rejects overlapping worker file scopes", () => {
  const context = structuredClone(example);
  context.workers[1].fileAllowlist = ["server/api/"];
  const result = validate(context);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /文件范围冲突/);
});

test("rejects paths that escape the repository", () => {
  const context = structuredClone(example);
  context.workers[0].fileAllowlist = ["../../outside/"];
  const result = validate(context);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /不安全路径/);
});

test("rejects cyclic worker dependencies", () => {
  const context = structuredClone(example);
  context.workers[0].dependsOn = ["frontend"];
  const result = validate(context);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /依赖形成循环/);
});

test("requires repair findings to be routed without turning them into user gates", () => {
  assert.ok(example.decisionGates.autoRouteWhen.some((item) => item.includes("review finding")));
  assert.ok(example.decisionGates.notifyUserWhen.some((item) => item.includes("scope")));
});

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("回到项目列表时由根组件关闭画布并清除自动恢复目标", async () => {
  const mainSource = await readFile(resolve(root, "src", "main.tsx"), "utf8");
  const appSource = await readFile(resolve(root, "src", "App.tsx"), "utf8");

  assert.match(mainSource, /setRequestedProjectId\(null\)/);
  assert.match(mainSource, /setProject\(null\)/);
  assert.match(mainSource, /urlForWorkbench\(window\.location\.href\)/);
  assert.match(mainSource, /onBackToProjects=\{returnToProjects\}/);
  assert.match(appSource, /void returnToProjects\(\)/);
  assert.doesNotMatch(appSource, /label="项目" onClick=\{\(\) => window\.location\.reload\(\)\}/);
});

test("保存失败或服务离线时不会离开当前画布", async () => {
  const source = await readFile(resolve(root, "src", "App.tsx"), "utf8");
  const returnStart = source.indexOf("const returnToProjects = useCallback(async () => {");
  const retryStart = source.indexOf("const retryProjectSave = useCallback", returnStart);
  assert.ok(returnStart >= 0 && retryStart > returnStart);
  const returnHandler = source.slice(returnStart, retryStart);

  assert.match(returnHandler, /serviceState !== "connected"/);
  assert.match(returnHandler, /const saved = await saveProjectNow\(\)/);
  assert.match(returnHandler, /if \(saved\) onBackToProjects\(\)/);
  assert.doesNotMatch(returnHandler, /await saveProjectNow\(\);\s*}\s*onBackToProjects\(\)/);
  assert.match(source, />重试保存<\/button>/);
});

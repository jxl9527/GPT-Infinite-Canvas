import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanvasProjectRepository } from "../src/canvas-project-repository.js";
import { ProjectRuntimeManager } from "../src/project-runtime-manager.js";
import { exportSimpleImages } from "../src/simple-export.js";

test("并行保存只接受一个新版本，旧界面保存保留简化模式草稿", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvas-simple-cas-"));
  const repo = new CanvasProjectRepository(root); await repo.init();
  const doc = { schemaVersion: "1.0", projectId: "project_00000000-0000-0000-0000-000000000701", title: "test", revision: 0,
    canvas: { viewport: { x: 0, y: 0, scale: 1 }, nodes: [] }, assets: [], versions: [], taskLinks: [],
    simple: { draft: "保留", concurrency: 2, selectedIds: [], batch: null } };
  await repo.save(doc, false, -1);
  const results = await Promise.allSettled([repo.save({ ...doc, revision: 1, title: "first" }, false, 0), repo.save({ ...doc, revision: 1, title: "second" }, false, 0)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const latest = repo.read()!;
  const legacy: Record<string, unknown> = { ...latest, revision: 2 }; delete legacy.simple;
  await repo.save(legacy);
  assert.deepEqual(repo.read()!.simple, doc.simple);
  await assert.rejects(repo.save({ ...repo.read(), revision: 3, simple: { ...doc.simple, concurrency: 3 } }));
});

test("提示词并行收录和更新保留版本与备份，普通导出不覆盖同名原图", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvas-simple-export-"));
  const manager = new ProjectRuntimeManager(join(root, "runtime"), join(root, "project")); await manager.init();
  const entries = await Promise.all([manager.savePrompt(undefined, "a", "字".repeat(20000)), manager.savePrompt(undefined, "b", "第二条")]);
  await manager.savePrompt(entries[0].id, "a", "新版", { category: "建筑" });
  assert.equal(manager.listPrompts().length, 2);
  assert.equal(manager.listPrompts().find((p) => p.id === entries[0].id)!.version, 2);
  assert.ok((await readdir(join(root, "runtime", "workbench", "prompt-library-history"))).length >= 2);
  const created = await manager.create("导出测试", undefined); await manager.activate(created.id); const project = manager.current()!;
  const { asset } = await project.canvasAssets.importDataUrl("底图.png", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL3SAAAAABJRU5ErkJggg==");
  await project.canvasProject.save({ schemaVersion: "1.0", projectId: "project_00000000-0000-0000-0000-000000000701", title: "export", revision: 0,
    canvas: { viewport: { x: 0, y: 0, scale: 1 }, nodes: [] }, assets: [asset], versions: [{ id: "version_source", assetId: asset.id, parentVersionId: null }], taskLinks: [] });
  const selections = [{ versionId: "version_source", assetId: asset.id, name: "CON.png" }];
  const first = await exportSimpleImages(project, join(root, "exports"), selections);
  const second = await exportSimpleImages(project, join(root, "exports"), selections);
  assert.equal(first.exported, 1); assert.equal(second.exported, 1);
  assert.notEqual(first.records[0]!.path, second.records[0]!.path);
  assert.deepEqual(await readFile(first.records[0]!.path!), await readFile(second.records[0]!.path!));
  const invalid = await exportSimpleImages(project, join(root, "exports"), [{ ...selections[0], assetId: "asset_wrong" }]);
  assert.equal(invalid.failed, 1);
});




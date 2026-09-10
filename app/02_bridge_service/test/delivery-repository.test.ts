import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CanvasAssetRepository } from "../src/canvas-asset-repository.js";
import { CanvasProjectRepository } from "../src/canvas-project-repository.js";
import { DeliveryRepository } from "../src/delivery-repository.js";
import { TaskStore } from "../src/task-store.js";

const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZ5wAAAABJRU5ErkJggg==";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "gpt-canvas-delivery-v3-"));
  const assets = new CanvasAssetRepository(root); await assets.init();
  const store = new TaskStore(root); await store.init();
  const canvasProject = new CanvasProjectRepository(root); await canvasProject.init();
  const generated = await assets.saveGeneratedAsset("1人视.png", pixel);
  const source = await assets.importDataUrl("1人视_D5.png", pixel);
  const now = new Date().toISOString();
  await canvasProject.save({
    schemaVersion: "2.0",
    projectId: "project_00000000-0000-0000-0000-000000000701",
    title: "最终玻璃导出测试",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    canvas: {
      viewport: { x: 0, y: 0, scale: 1 },
      nodes: [{
        id: "node_00000000-0000-0000-0000-000000000701",
        type: "image",
        x: 0,
        y: 0,
        width: 640,
        height: 427,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: 0,
        locked: false,
        visible: true,
        payload: { imageVersionId: "version_source_01", fit: "cover" }
      }]
    },
    assets: [source.asset, generated.asset],
    versions: [
      { id: "version_source_01", assetId: source.asset.id, origin: "imported", parentVersionId: null, taskId: null, createdAt: now },
      { id: "version_glass_01", assetId: generated.asset.id, origin: "generated", parentVersionId: "version_source_01", taskId: "task_glass_01", createdAt: now }
    ],
    taskLinks: [{ taskId: "task_glass_01", parentVersionId: "version_source_01", resultVersionIds: ["version_glass_01"], status: "completed" }],
    workflow: {
      activeViewpointId: "viewpoint_glass_01",
      viewpoints: [{
        id: "viewpoint_glass_01",
        name: "1人视",
        purpose: "主入口",
        stage: "final-glass",
        status: "in-progress",
        statusMode: "auto",
        d5Batch: "D5_01",
        sourceVersionId: "version_source_01",
        selectedVersionId: "version_glass_01",
        conclusion: "",
        nextAction: "",
        preflight: { d5ViewVersionId: "version_source_01", suReferenceVersionId: null, conclusionCardId: null, status: "pending" },
        sceneOptimization: { structureBaseVersionId: null, styleReferenceVersionId: null, promptCardId: null, candidateVersionIds: [], selectedVersionId: null, status: "not-run" },
        finalGlass: { finalD5VersionId: "version_source_01", candidateVersionIds: ["version_glass_01"], selectedVersionIds: ["version_glass_01"], validation: "passed", status: "selected" },
        export: { targetDirectory: null, exportedVersionIds: [], exportedFiles: [], exportedAt: null, status: "pending" },
        updatedAt: now
      }],
      handoffs: [],
      customGptUrl: "",
      customGptEnabled: false,
      textCards: [],
      batchRun: null
    }
  });
  const delivery = new DeliveryRepository(root, assets, store, canvasProject); await delivery.init();
  const target = join(root, "exports", "玻璃深化");
  await mkdir(join(root, "exports"), { recursive: true });
  await delivery.saveTarget(target);
  return { root, assets, delivery, generated, target };
}

test("最终玻璃成果批量导出顺延命名、去重并记录日志", async () => {
  const { root, delivery, generated, target } = await setup();
  const selection = {
    assetId: generated.asset.id,
    versionId: "version_glass_01",
    viewpointName: "1人视.png"
  };
  const first = await delivery.exportSelected([selection]);
  assert.equal(first.completed, true);
  assert.equal(first.exported, 1);
  assert.equal(first.records[0]?.filename, "1人视_玻璃整图_01.png");
  assert.equal(first.records[0]?.destinationPath, join(target, "1人视_玻璃整图_01.png"));

  const duplicate = await delivery.exportSelected([selection]);
  assert.equal(duplicate.deduplicated, 1);
  assert.equal((await readdir(target)).length, 1);
  const log = await readFile(join(root, "logs", "final-glass-export.ndjson"), "utf8");
  assert.match(log, /"status":"exported"/);
  assert.match(log, /"status":"deduplicated"/);
});

test("批量导出保留成功项并报告单项失败", async () => {
  const { delivery, generated } = await setup();
  const result = await delivery.exportSelected([
    { assetId: generated.asset.id, versionId: "version_glass_01", viewpointName: "1人视" },
    { assetId: "asset_missing", versionId: "version_missing", viewpointName: "2鸟瞰" }
  ]);
  assert.equal(result.completed, false);
  assert.equal(result.exported, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.records[1]?.status, "failed");
});

test("导出目录允许用户指定名称但拒绝磁盘根目录", async () => {
  const { root, delivery } = await setup();
  const custom = join(root, "任意成果目录");
  const saved = await delivery.saveTarget(custom);
  assert.equal(saved.schemaVersion, "2.0");
  assert.equal(saved.targetDirectory, custom);
  await assert.rejects(() => delivery.saveTarget("C:\\"), /磁盘根目录/);
});

test("旧 AI 目录配置可读取为 V3 导出目标", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-canvas-delivery-legacy-"));
  const assets = new CanvasAssetRepository(root); await assets.init();
  const store = new TaskStore(root); await store.init();
  const canvasProject = new CanvasProjectRepository(root); await canvasProject.init();
  const legacyDirectory = join(root, "效果图", "AI");
  await mkdir(legacyDirectory, { recursive: true });
  await mkdir(join(root, "context"), { recursive: true });
  await writeFile(join(root, "context", "delivery-target.json"), JSON.stringify({
    schemaVersion: "1.0",
    aiDirectory: legacyDirectory,
    finalDirectory: join(root, "效果图", "成图"),
    configuredAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z"
  }), "utf8");
  const delivery = new DeliveryRepository(root, assets, store, canvasProject); await delivery.init();
  assert.equal((await delivery.readTarget())?.targetDirectory, legacyDirectory);
});

test("批量导出拒绝伪造版本和未人工选定的资产关系", async () => {
  const { delivery, generated } = await setup();
  const result = await delivery.exportSelected([{
    assetId: generated.asset.id,
    versionId: "version_fabricated",
    viewpointName: "1人视"
  }]);
  assert.equal(result.completed, false);
  assert.equal(result.failed, 1);
  assert.match(result.records[0]?.error ?? "", /版本不存在|不匹配/);
});

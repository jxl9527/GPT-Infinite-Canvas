import test from "node:test";
import assert from "node:assert/strict";
import type { CanvasProjectDocument } from "../src/project-state.js";
import { buildComparisonPair, comparisonSiblings, rootBaseVersionId, sliderPercent } from "../src/comparison-model.js";

function imageAsset(id: string, name: string, width: number, height: number) {
  return { id, kind: "imported", originalName: name, createdAt: "now", original: { width, height, relativePath: `assets/${id}.png`, mime: "image/png", bytes: 1, sha256: "a".repeat(64) } };
}

function fixture(): CanvasProjectDocument {
  return {
    schemaVersion: "2.0", projectId: "project_compare", title: "test", createdAt: "now", updatedAt: "now", revision: 1,
    canvas: { viewport: { x: 0, y: 0, scale: 1 }, nodes: [] },
    assets: [imageAsset("asset_root", "原图.png", 1600, 900), imageAsset("asset_child", "中间.png", 1600, 900), imageAsset("asset_grand", "结果.png", 1672, 941), imageAsset("asset_wide", "异比例.png", 1200, 800)],
    versions: [
      { id: "version_root", assetId: "asset_root", origin: "imported", parentVersionId: null, taskId: null, createdAt: "now" },
      { id: "version_child", assetId: "asset_child", origin: "generated", parentVersionId: "version_root", taskId: "task_a", createdAt: "now" },
      { id: "version_grand", assetId: "asset_grand", origin: "generated", parentVersionId: "version_child", taskId: "task_b", createdAt: "now" },
      { id: "version_wide", assetId: "asset_wide", origin: "generated", parentVersionId: "version_child", taskId: "task_c", createdAt: "now" }
    ],
    taskLinks: [],
    simple: {
      draft: "", concurrency: 2, copiesPerImage: 1, selectedIds: [],
      batch: {
        id: "simple_x", prompt: "p", concurrency: 2, paused: false, createdAt: "now",
        items: [{ id: "item_b", sourceVersionId: "version_child", sourceName: "中间.png", taskId: "task_b", status: "completed", resultVersionIds: ["version_grand"], error: "", variantOrdinal: 2 }]
      }
    }
  } as unknown as CanvasProjectDocument;
}

test("对比默认取直接父版本，可切换到最初原图", () => {
  const document = fixture();
  const pair = buildComparisonPair(document, "version_grand")!;
  assert.equal(pair.baseVersionId, "version_child");
  assert.equal(pair.rootBaseVersionId, "version_root");
  assert.equal(pair.isRootBase, false);
  assert.equal(pair.resultOrdinal, 2);
  assert.equal(pair.baseName, "中间.png");
  assert.equal(pair.ratioMismatch, false);
  const root = buildComparisonPair(document, "version_grand", true)!;
  assert.equal(root.baseVersionId, "version_root");
  assert.equal(root.isRootBase, true);
  assert.equal(root.baseName, "原图.png");
  assert.equal(buildComparisonPair(document, "version_wide")!.ratioMismatch, true);
});

test("缺少父版本或资产时对比降级返回空", () => {
  const document = fixture();
  assert.equal(buildComparisonPair(document, "version_root"), null);
  assert.equal(buildComparisonPair(document, "version_missing"), null);
  const missing = fixture();
  missing.assets = missing.assets.filter((asset) => asset.id !== "asset_child");
  assert.equal(buildComparisonPair(missing, "version_grand"), null);
  assert.equal(rootBaseVersionId(missing, "version_grand"), "version_root");
});

test("版本切换只包含同父版本的兄弟结果", () => {
  const document = fixture();
  assert.deepEqual(comparisonSiblings(document, "version_grand"), ["version_grand", "version_wide"]);
  assert.deepEqual(comparisonSiblings(document, "version_child"), ["version_child"]);
  assert.deepEqual(comparisonSiblings(document, "version_missing"), ["version_missing"]);
});

test("滑块百分比限制在 0 到 100", () => {
  assert.equal(sliderPercent(-10), 0);
  assert.equal(sliderPercent(50.4), 50);
  assert.equal(sliderPercent(140), 100);
});

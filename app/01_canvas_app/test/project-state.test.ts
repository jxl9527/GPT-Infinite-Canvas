import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasImageAsset } from "@gpt-canvas/shared";
import type { ImageNodeState } from "../src/canvas-layout.js";
import {
  buildCanvasProjectDocument,
  restoreCanvasProjectStructure
} from "../src/project-state.js";

const asset: CanvasImageAsset = {
  id: "asset_00000000-0000-0000-0000-000000000001",
  kind: "imported",
  originalName: "结构图.png",
  original: {
    relativePath: "assets/originals/asset_00000000-0000-0000-0000-000000000001.png",
    mime: "image/png",
    width: 1536,
    height: 1024,
    bytes: 100,
    sha256: "a".repeat(64)
  },
  createdAt: "2026-07-23T00:00:00.000Z"
};

const node: ImageNodeState = {
  id: "node_00000000-0000-0000-0000-000000000001",
  assetId: asset.id,
  originalRelativePath: asset.original.relativePath,
  versionId: "version_00000000-0000-0000-0000-000000000001",
  origin: "imported",
  parentVersionId: null,
  taskId: null,
  name: asset.originalName,
  src: "data:image/png;base64,AA==",
  sourceWidth: 1536,
  sourceHeight: 1024,
  x: 123,
  y: 234,
  width: 640,
  height: 427,
  outputRatio: "free"
};

test("项目保存与恢复保持节点、批注和版本引用", () => {
  const project = buildCanvasProjectDocument({
    projectId: "project_00000000-0000-0000-0000-000000000001",
    title: "恢复测试",
    createdAt: "2026-07-23T00:00:00.000Z",
    revision: 20,
    viewport: { x: 72, y: 54, scale: 0.74 },
    nodes: [node],
    annotations: [{
      id: "annotation_00000000-0000-0000-0000-000000000001",
      type: "text",
      x: 240,
      y: 180,
      color: "#b9472e",
      text: "保持主入口",
      width: 240,
      fontSize: 24
    }],
    assets: [asset],
    generationTask: null,
    taskParentVersionId: null
  });
  const restored = restoreCanvasProjectStructure(project);
  assert.deepEqual(restored.viewport, { x: 72, y: 54, scale: 0.74 });
  assert.equal(restored.imageNodes[0]?.x, 123);
  assert.equal(restored.imageNodes[0]?.versionId, node.versionId);
  assert.equal(restored.annotations[0]?.type, "text");
  assert.equal(project.versions[0]?.assetId, asset.id);
  assert.equal(new Set(project.canvas.nodes.map((entry) => entry.id)).size, project.canvas.nodes.length);
  assert.match(project.canvas.nodes[1]?.id ?? "", /^node_annotation_/);
});

test("未登记资产不得保存到项目", () => {
  assert.throws(() => buildCanvasProjectDocument({
    projectId: "project_00000000-0000-0000-0000-000000000001",
    title: "引用测试",
    createdAt: "2026-07-23T00:00:00.000Z",
    revision: 1,
    viewport: { x: 0, y: 0, scale: 1 },
    nodes: [node],
    annotations: [],
    assets: [],
    generationTask: null,
    taskParentVersionId: null
  }), /节点资产未登记/);
});

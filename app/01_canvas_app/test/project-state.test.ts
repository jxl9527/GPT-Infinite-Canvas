import assert from "node:assert/strict";
import test from "node:test";
import type { CanvasImageAsset } from "@gpt-canvas/shared";
import type { ImageNodeState } from "../src/canvas-layout.js";
import {
  buildCanvasProjectDocument,
  createViewpointStatusCard,
  restoreCanvasProjectStructure
} from "../src/project-state.js";
import type { CanvasProjectDocument } from "../src/project-state.js";

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

const longPromptText = `【最终生成提示词】\n${"保持建筑结构、道路关系和原始视角不变。".repeat(220)}`;

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
    taskParentVersionId: null,
    workflow: {
      activeViewpointId: "viewpoint_00000000-0000-0000-0000-000000000001",
      batchRun: {
        id: "batch_00000000-0000-0000-0000-000000000001",
        status: "ready",
        prompt: "批量提示词",
        styleReferenceVersionId: null,
        targetChatUrl: "",
        items: [{
          id: "batch_item_00000000-0000-0000-0000-000000000001",
          sourceVersionId: node.versionId,
          sourceName: node.name,
          status: "queued",
          taskId: null,
          resultVersionIds: [],
          error: ""
        }],
        createdAt: "2026-07-23T01:00:00.000Z",
        updatedAt: "2026-07-23T01:00:00.000Z"
      },
      customGptUrl: "https://chatgpt.com/g/g-architect-review",
      customGptEnabled: false,
      textCards: [{
        id: "text_card_00000000-0000-0000-0000-000000000001",
        kind: "prompt",
        title: "1人视｜生成提示词",
        text: longPromptText,
        x: 820,
        y: 234,
        width: 460,
        height: 360,
        sourceVersionId: node.versionId,
        taskId: "task_00000000-0000-0000-0000-000000000001",
        createdAt: "2026-07-23T01:00:00.000Z",
        updatedAt: "2026-07-23T01:00:00.000Z"
      }],
      viewpoints: [{
        ...createViewpointStatusCard({
        id: "viewpoint_00000000-0000-0000-0000-000000000001",
        name: "1人视",
        purpose: "主入口投标主图",
        stage: "scene-optimization",
        d5Batch: "D5_01",
        sourceVersionId: node.versionId,
        updatedAt: "2026-07-23T01:00:00.000Z"
        }),
        status: "in-progress",
        conclusion: "构图已锁定",
        nextAction: "继续D5材质深化",
        updatedAt: "2026-07-23T01:00:00.000Z"
      }],
      handoffs: []
    }
  });
  const restored = restoreCanvasProjectStructure(project);
  assert.deepEqual(restored.viewport, { x: 72, y: 54, scale: 0.74 });
  assert.equal(restored.imageNodes[0]?.x, 123);
  assert.equal(restored.imageNodes[0]?.versionId, node.versionId);
  assert.equal(restored.annotations[0]?.type, "text");
  assert.equal(project.versions[0]?.assetId, asset.id);
  assert.equal(restored.workflow.viewpoints[0]?.name, "1人视");
  assert.equal(restored.workflow.viewpoints[0]?.sourceVersionId, node.versionId);
  assert.equal(restored.workflow.customGptUrl, "https://chatgpt.com/g/g-architect-review");
  assert.equal(restored.workflow.customGptEnabled, false);
  assert.equal(project.workflow?.batchRun?.targetChatUrl, null);
  assert.equal(restored.workflow.batchRun?.targetChatUrl, null);
  assert.equal(restored.workflow.textCards[0]?.kind, "prompt");
  assert.equal(restored.workflow.textCards[0]?.text, longPromptText);
  assert.equal(project.schemaVersion, "2.0");
  assert.equal(restored.workflow.viewpoints[0]?.sceneOptimization.structureBaseVersionId, node.versionId);
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
    taskParentVersionId: null,
    workflow: { activeViewpointId: null, viewpoints: [], handoffs: [], batchRun: null, customGptUrl: "", customGptEnabled: false, textCards: [] }
  }), /节点资产未登记/);
});

test("旧四阶段项目迁移为V3三阶段且保留项目数据", () => {
  const legacy = buildCanvasProjectDocument({
    projectId: "project_00000000-0000-0000-0000-000000000001",
    title: "旧项目迁移",
    createdAt: "2026-07-23T00:00:00.000Z",
    revision: 3,
    viewport: { x: 0, y: 0, scale: 1 },
    nodes: [node],
    annotations: [],
    assets: [asset],
    generationTask: null,
    taskParentVersionId: null,
    workflow: { activeViewpointId: null, viewpoints: [], handoffs: [], batchRun: null, customGptUrl: "", customGptEnabled: false, textCards: [] }
  });
  legacy.schemaVersion = "1.0";
  legacy.workflow = {
    activeViewpointId: "viewpoint_legacy",
    viewpoints: [{
      id: "viewpoint_legacy",
      name: "1人视",
      purpose: "主入口",
      stage: "stage-2",
      status: "in-progress",
      d5Batch: "D5_01",
      sourceVersionId: node.versionId,
      selectedVersionId: null,
      conclusion: "补充入口窗框",
      nextAction: "返回SU",
      updatedAt: "2026-07-23T01:00:00.000Z"
    }],
    handoffs: [{
      id: "handoff_legacy",
      viewpointId: "viewpoint_legacy",
      viewpointName: "1人视",
      stage: "stage-4",
      status: "in-progress",
      target: "photoshop",
      d5Batch: "D5_01",
      sourceVersionId: node.versionId,
      selectedVersionId: null,
      taskId: null,
      conclusion: "玻璃待处理",
      nextAction: "旧流程",
      createdAt: "2026-07-23T01:00:00.000Z"
    }],
    batchRun: null,
    customGptUrl: "",
    customGptEnabled: false,
    textCards: []
  } as unknown as CanvasProjectDocument["workflow"];
  const restored = restoreCanvasProjectStructure(legacy);
  assert.equal(restored.imageNodes.length, 1);
  assert.equal(restored.workflow.viewpoints[0]?.stage, "preflight");
  assert.equal(restored.workflow.viewpoints[0]?.preflight.d5ViewVersionId, node.versionId);
  assert.equal(restored.workflow.viewpoints[0]?.conclusion, "补充入口窗框");
  assert.equal(restored.workflow.handoffs[0]?.stage, "final-glass");
  assert.equal(restored.workflow.handoffs[0]?.target, "review");
});

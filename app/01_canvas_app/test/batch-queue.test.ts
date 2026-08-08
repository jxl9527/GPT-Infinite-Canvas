import assert from "node:assert/strict";
import test from "node:test";
import type { ImageNodeState } from "../src/canvas-layout.js";
import {
  batchProgress,
  createCanvasBatchRun,
  createStageCanvasBatchRun,
  defaultWorkflowAction,
  nextQueuedBatchItem,
  updateBatchItem,
  workflowActionAllowed
} from "../src/batch-queue.js";
import { workflowStagePrompt } from "../src/fixed-workflow-prompts.js";

function node(name: string): ImageNodeState {
  return {
    id: `node_${name}`,
    assetId: `asset_${name}`,
    originalRelativePath: `assets/${name}.png`,
    versionId: `version_${name}`,
    origin: "imported",
    parentVersionId: null,
    taskId: null,
    name: `${name}.png`,
    src: "data:image/png;base64,AA==",
    sourceWidth: 1600,
    sourceHeight: 900,
    x: 0,
    y: 0,
    width: 640,
    height: 360,
    outputRatio: "free"
  };
}

test("batch queue keeps source order and reports progress", () => {
  const run = createCanvasBatchRun(
    [node("D5_2"), node("D5_10")],
    "提升材质",
    null,
    {},
    "2026-08-03T00:00:00.000Z"
  );
  assert.equal(run.items[0]?.sourceName, "D5_2.png");
  assert.equal(nextQueuedBatchItem(run)?.sourceName, "D5_2.png");
  const next = updateBatchItem(run, run.items[0]!.id, { status: "completed", resultVersionIds: ["version_result"] });
  assert.deepEqual(batchProgress(next), { total: 2, completed: 1, failed: 0, remaining: 1, percent: 50 });
  assert.equal(nextQueuedBatchItem(next)?.sourceName, "D5_10.png");
});

test("前置阶段把多个不同D5视角拆成独立文字任务", () => {
  const d5A = node("1人视");
  const d5B = node("2鸟瞰");
  const run = createStageCanvasBatchRun({
    sources: [d5A, d5B],
    stage: "preflight",
    action: "analyze",
    prompt: workflowStagePrompt("preflight", "analyze"),
    structureBase: null,
    styleReference: null,
    targetChatUrl: ""
  });
  assert.equal(run.items.length, 2);
  assert.equal(run.responseMode, "text");
  assert.deepEqual(run.items.map((item) => item.sourceVersionId), [d5A.versionId, d5B.versionId]);
  assert.deepEqual(run.items.map((item) => item.attachmentVersionIds), [[d5A.versionId], [d5B.versionId]]);
  assert.deepEqual(run.items.map((item) => item.attachmentRoles), [["d5-locked-view"], ["d5-locked-view"]]);
  assert.ok(run.items.every((item) => item.outputKind === "preflight-review"));
});

test("前置阶段为每个D5视角明确配对可选SU截图", () => {
  const d5A = node("1人视"); const d5B = node("2鸟瞰"); const suA = node("1人视_SU");
  const pairs = new Map<`version_${string}`, ImageNodeState>([[d5A.versionId, suA]]);
  const run = createStageCanvasBatchRun({
    sources: [d5A, d5B], stage: "preflight", action: "analyze", prompt: "前置审查",
    structureBase: null, styleReference: null, targetChatUrl: "", suReferenceBySourceVersionId: pairs
  });
  assert.deepEqual(run.items[0]?.attachmentVersionIds, [d5A.versionId, suA.versionId]);
  assert.deepEqual(run.items[0]?.attachmentRoles, ["d5-locked-view", "su-reference"]);
  assert.deepEqual(run.items[1]?.attachmentVersionIds, [d5B.versionId]);
  assert.throws(() => createStageCanvasBatchRun({
    sources: [d5A], stage: "preflight", action: "analyze", prompt: "前置审查",
    structureBase: null, styleReference: null, targetChatUrl: "",
    suReferenceBySourceVersionId: new Map([[d5A.versionId, d5A]])
  }), /不能是同一张/);
});

test("优化阶段可直接进入且提示词与生图保持两个独立动作", () => {
  const baseA = node("base_A"); const baseB = node("base_B"); const style = node("style");
  const promptRun = createStageCanvasBatchRun({
    sources: [baseA, baseB, style], stage: "scene-optimization", action: "prompt", prompt: "场景提示词",
    structureBase: baseA, styleReference: style, targetChatUrl: ""
  });
  assert.equal(promptRun.responseMode, "text");
  assert.equal(promptRun.items.length, 2);
  assert.deepEqual(promptRun.items.map((item) => item.attachmentRoles), [
    ["structure-base", "style-reference"],
    ["structure-base", "style-reference"]
  ]);
  const imageRun = createStageCanvasBatchRun({
    sources: [baseA], stage: "scene-optimization", action: "generate", prompt: "已确认提示词",
    structureBase: baseA, styleReference: null, targetChatUrl: ""
  });
  assert.equal(imageRun.responseMode, "image");
  assert.equal(imageRun.items[0]?.outputKind, "d5-scene-target");
});

test("最终阶段可直接进入且每张最终D5只形成一个整图玻璃任务", () => {
  const d5A = node("D5_final_A"); const d5B = node("D5_final_B");
  const run = createStageCanvasBatchRun({
    sources: [d5A, d5B], stage: "final-glass", action: "generate", prompt: "玻璃深化",
    structureBase: null, styleReference: null, targetChatUrl: ""
  });
  assert.equal(run.items.length, 2);
  assert.equal(run.responseMode, "image");
  assert.deepEqual(run.items.map((item) => item.attachmentVersionIds), [[d5A.versionId], [d5B.versionId]]);
  assert.ok(run.items.every((item) => item.outputKind === "glass-deepened-full-frame"));
});

test("三阶段只开放当前阶段的有效动作且不存在前序完成门槛", () => {
  assert.equal(defaultWorkflowAction("preflight"), "analyze");
  assert.equal(defaultWorkflowAction("scene-optimization"), "prompt");
  assert.equal(defaultWorkflowAction("final-glass"), "generate");
  assert.equal(workflowActionAllowed("preflight", "generate"), false);
  assert.equal(workflowActionAllowed("scene-optimization", "prompt"), true);
  assert.equal(workflowActionAllowed("scene-optimization", "generate"), true);
  assert.equal(workflowActionAllowed("final-glass", "prompt"), false);
  assert.throws(() => createStageCanvasBatchRun({
    sources: [node("D5")], stage: "preflight", action: "generate", prompt: "错误动作",
    structureBase: null, styleReference: null, targetChatUrl: ""
  }), /不支持/);
});

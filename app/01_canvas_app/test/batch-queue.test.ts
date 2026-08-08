import assert from "node:assert/strict";
import test from "node:test";
import type { ImageNodeState } from "../src/canvas-layout.js";
import {
  batchProgress,
  createCanvasBatchRun,
  createStageCanvasBatchRun,
  nextQueuedBatchItem,
  updateBatchItem
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

test("阶段批次冻结阶段动作并允许普通 GPT 新对话", () => {
  const prompt = workflowStagePrompt("stage-3", "prompt");
  const run = createCanvasBatchRun([node("D5_1")], prompt, null, {
    promptMode: "stage-only",
    workflowStage: "stage-3",
    workflowAction: "prompt",
    responseMode: "text",
    targetChatUrl: ""
  });
  assert.equal(run.prompt, prompt);
  assert.match(run.prompt, /只返回文字/);
  assert.equal(run.promptMode, "stage-only");
  assert.equal(run.workflowStage, "stage-3");
  assert.equal(run.workflowAction, "prompt");
  assert.equal(run.targetChatUrl, "");
});

test("阶段一把三个候选视角组成同一个文字审查任务", () => {
  const sources = [node("A"), node("B"), node("C")];
  const run = createStageCanvasBatchRun({
    sources,
    stage: "stage-1",
    action: "analyze",
    prompt: workflowStagePrompt("stage-1", "analyze"),
    structureBase: null,
    styleReference: null,
    targetChatUrl: "https://chatgpt.com/g/g-architect-review"
  });
  assert.equal(run.items.length, 1);
  assert.equal(run.responseMode, "text");
  assert.deepEqual(run.items[0]?.attachmentVersionIds, sources.map((source) => source.versionId));
  assert.deepEqual(run.items[0]?.attachmentRoles, ["content-reference", "content-reference", "content-reference"]);
});

test("阶段二固定D5与SU角色，阶段四每张最终D5整图单独生成", () => {
  const d5 = node("D5"); const su = node("SU"); const maskA = node("mask_A"); const maskB = node("mask_B");
  const stageTwo = createStageCanvasBatchRun({
    sources: [su, d5], stage: "stage-2", action: "analyze", prompt: "阶段二审查", structureBase: d5,
    styleReference: null, targetChatUrl: "https://chatgpt.com/g/g-architect-review"
  });
  assert.deepEqual(stageTwo.items[0]?.attachmentRoles, ["d5-locked-view", "su-reference"]);
  assert.equal(stageTwo.responseMode, "text");

  const stageFour = createStageCanvasBatchRun({
    sources: [d5, maskA, maskB], stage: "stage-4", action: "generate", prompt: "阶段四玻璃", structureBase: d5,
    styleReference: null, targetChatUrl: "https://chatgpt.com/g/g-architect-review"
  });
  assert.equal(stageFour.items.length, 3);
  assert.equal(stageFour.responseMode, "image");
  assert.deepEqual(stageFour.items.map((item) => item.attachmentRoles), [
    ["structure-base"],
    ["structure-base"],
    ["structure-base"]
  ]);
});

test("阶段三为每张底图附带同一风格参考", () => {
  const baseA = node("base_A"); const baseB = node("base_B"); const style = node("style");
  const run = createStageCanvasBatchRun({
    sources: [baseA, baseB, style], stage: "stage-3", action: "prompt", prompt: "阶段三提示词", structureBase: baseA,
    styleReference: style, targetChatUrl: "https://chatgpt.com/g/g-architect-review"
  });
  assert.equal(run.items.length, 2);
  assert.equal(run.responseMode, "text");
  assert.deepEqual(run.items.map((item) => item.attachmentRoles), [
    ["structure-base", "style-reference"],
    ["structure-base", "style-reference"]
  ]);
});

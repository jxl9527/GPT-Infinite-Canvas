import assert from "node:assert/strict";
import test from "node:test";
import type { ImageNodeState } from "../src/canvas-layout.js";
import {
  batchProgress,
  browserAutomationOwnsBatch,
  codexStageAutomationPlan,
  createCanvasBatchRun,
  createPromptCardGenerationBatchRun,
  createStageCanvasBatchRun,
  defaultWorkflowAction,
  nextQueuedBatchItem,
  promptCardBatchReady,
  promptForBatchItem,
  resolvePromptCardBatchPairs,
  selectCodexCanvasSources,
  updateBatchItem,
  workflowActionAllowed
} from "../src/batch-queue.js";
import { createViewpointStatusCard } from "../src/project-state.js";
import type { CanvasTextCard } from "../src/text-card.js";
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

function promptCard(name: string, sourceVersionId: `version_${string}`, finalPrompt: string): CanvasTextCard {
  return {
    id: `text_card_${name}`,
    kind: "prompt",
    title: `${name}｜生成提示词`,
    text: `【D5调整建议】这部分只供设计师复核。\n【最终生成提示词】${finalPrompt}\n【必须保持与禁止改变】保持建筑结构与相机不变。`,
    x: 0,
    y: 0,
    width: 460,
    height: 360,
    sourceVersionId,
    taskId: `task_${name}`,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z"
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

test("A模式优化阶段可直接进入且提示词与生图保持两个独立动作", () => {
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

test("A模式可将每张原图与其已返回提示词卡一一配对并冻结独立输入", () => {
  const baseA = node("1人视");
  const baseB = node("2鸟瞰");
  const cardA = promptCard("人视", baseA.versionId, "把人视画面优化为清透明亮日景。");
  const cardB = promptCard("鸟瞰", baseB.versionId, "把鸟瞰画面优化为克制的清晨氛围。");
  const viewpointA = createViewpointStatusCard({ name: "1人视", stage: "scene-optimization", sourceVersionId: baseA.versionId });
  const viewpointB = createViewpointStatusCard({ name: "2鸟瞰", stage: "scene-optimization", sourceVersionId: baseB.versionId });
  viewpointA.sceneOptimization = { ...viewpointA.sceneOptimization, promptCardId: cardA.id, status: "prompt-ready" };
  viewpointB.sceneOptimization = { ...viewpointB.sceneOptimization, promptCardId: cardB.id, status: "prompt-ready" };

  const pairs = resolvePromptCardBatchPairs([baseA, baseB], [viewpointA, viewpointB], [cardA, cardB]);
  assert.equal(promptCardBatchReady(pairs), true);
  assert.deepEqual(pairs.map((pair) => pair.promptCard?.id), [cardA.id, cardB.id]);
  assert.doesNotMatch(pairs[0]?.prompt ?? "", /D5调整建议|设计师复核/);

  const run = createPromptCardGenerationBatchRun({ pairs, styleReference: null, targetChatUrl: "" }, "2026-08-13T00:00:00.000Z");
  assert.deepEqual(run.items.map((item) => item.inputTextCardId), [cardA.id, cardB.id]);
  assert.match(run.items[0]?.inputPrompt ?? "", /清透明亮日景/);
  assert.doesNotMatch(run.items[0]?.inputPrompt ?? "", /清晨氛围/);
  assert.match(run.items[1]?.inputPrompt ?? "", /清晨氛围/);
  assert.doesNotMatch(run.items[1]?.inputPrompt ?? "", /清透明亮日景/);
  assert.match(promptForBatchItem("基础结构保护", run.items[0]!), /本视角已确认提示词[\s\S]*清透明亮日景/);
});

test("A模式一一对应批次在任一提示词卡缺失或错配时拒绝启动", () => {
  const baseA = node("1人视");
  const baseB = node("2鸟瞰");
  const cardA = promptCard("人视", baseA.versionId, "优化日景。");
  const viewpointA = createViewpointStatusCard({ name: "1人视", stage: "scene-optimization", sourceVersionId: baseA.versionId });
  const viewpointB = createViewpointStatusCard({ name: "2鸟瞰", stage: "scene-optimization", sourceVersionId: baseB.versionId });
  viewpointA.sceneOptimization = { ...viewpointA.sceneOptimization, promptCardId: cardA.id, status: "prompt-ready" };
  const pairs = resolvePromptCardBatchPairs([baseA, baseB], [viewpointA, viewpointB], [cardA]);
  assert.equal(promptCardBatchReady(pairs), false);
  assert.equal(pairs[1]?.issue, "缺少已返回提示词卡");
  assert.throws(() => createPromptCardGenerationBatchRun({ pairs, styleReference: null, targetChatUrl: "" }), /未就绪或错配/);
});

test("B模式优化阶段固定连续执行提示词与目标图", () => {
  const plan = codexStageAutomationPlan("scene-optimization");
  assert.equal(plan.action, "generate");
  assert.equal(plan.label, "提示词 → 生成图片");
  assert.match(plan.detail, /无需二次选择/);
  assert.equal(codexStageAutomationPlan("preflight").action, "analyze");
  assert.equal(codexStageAutomationPlan("final-glass").action, "generate");
  const run = createStageCanvasBatchRun({
    sources: [node("B模式底图")], stage: "scene-optimization", action: "generate", prompt: "结构锁定",
    structureBase: null, styleReference: null, targetChatUrl: "", runner: "codex"
  });
  assert.equal(browserAutomationOwnsBatch(run), false);
});

test("B模式可直接从当前画布框选或已登记图片建立输入范围", () => {
  const selected = node("selected");
  const prepared = node("prepared");
  const registered = node("registered");
  const imported = node("imported");
  assert.deepEqual(
    selectCodexCanvasSources([selected, selected], [prepared], [registered], [imported]).map((item) => item.versionId),
    [selected.versionId]
  );
  assert.deepEqual(
    selectCodexCanvasSources([], [prepared], [registered], [imported]).map((item) => item.versionId),
    [prepared.versionId]
  );
  assert.deepEqual(
    selectCodexCanvasSources([], [], [registered], [imported]).map((item) => item.versionId),
    [registered.versionId]
  );
  assert.deepEqual(
    selectCodexCanvasSources([], [], [], [imported]).map((item) => item.versionId),
    [imported.versionId]
  );
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

test("A模式批次写入统一执行器、检查点与幂等元数据", () => {
  const source = node("1人视");
  const run = createStageCanvasBatchRun({
    sources: [source],
    stage: "preflight",
    action: "analyze",
    prompt: "检查构图并保护建筑结构",
    structureBase: null,
    styleReference: null,
    targetChatUrl: "",
    runner: "manual"
  });
  assert.equal(run.runner, "manual");
  assert.equal(run.authorization, null);
  assert.equal(run.items[0]?.runner, "manual");
  assert.equal(run.items[0]?.checkpoint, null);
  assert.equal(run.items[0]?.attemptCount, 0);
  assert.match(run.items[0]?.idempotencyKey ?? "", /^manual:version_1人视:batch_item_/);
});

test("B模式批次保留用户确认的运行授权单", () => {
  const source = node("2鸟瞰");
  const authorization = {
    id: "authorization_00000000-0000-0000-0000-000000000001" as const,
    sourceFolder: "D:\\项目\\产业园\\效果图",
    stage: "scene-optimization" as const,
    itemCount: 1,
    maximumGenerations: 2,
    allowManualFallback: true,
    stopOnStructureRisk: true,
    approvedAt: "2026-08-10T00:00:00.000Z"
  };
  const run = createStageCanvasBatchRun({
    sources: [source],
    stage: "scene-optimization",
    action: "prompt",
    prompt: "生成场景优化提示词",
    structureBase: source,
    styleReference: null,
    targetChatUrl: "",
    runner: "codex",
    authorization,
    codexThreadId: "019fe6fe-4f7a-78f1-9333-f958e187dcc6"
  });
  assert.equal(run.runner, "codex");
  assert.deepEqual(run.authorization, authorization);
  assert.equal(run.codexThreadId, "019fe6fe-4f7a-78f1-9333-f958e187dcc6");
  assert.equal(run.items[0]?.runner, "codex");
  assert.match(run.items[0]?.idempotencyKey ?? "", /^codex:version_2鸟瞰:batch_item_/);
});

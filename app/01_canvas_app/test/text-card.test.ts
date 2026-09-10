import assert from "node:assert/strict";
import test from "node:test";
import {
  alignedGlassFilename,
  aspectRatiosMatch,
  buildPromptOptimizerInput,
  createCanvasTextCard,
  extractFinalPrompt,
  extractImageGenerationPrompt,
  inferTextCardWorkflowLabel,
  normalizeReturnedText,
  parseReturnedTextSections,
  nextWorkflowActionForTextCard,
  resizedTextCardSize,
  stripAssistantConversationTail,
  textCardHandoffLabel
} from "../src/text-card.js";

test("提示词结果卡只使用待确认、已载入和已使用三种交接状态", () => {
  assert.equal(textCardHandoffLabel(undefined), "待确认");
  assert.equal(textCardHandoffLabel("loaded"), "已载入输入框");
  assert.equal(textCardHandoffLabel("used"), "已用于生成");
});

test("02B提示词载入后生成图片，继续优化则建立带原提示词的02C输入", () => {
  assert.equal(nextWorkflowActionForTextCard("prompt"), "generate");
  assert.equal(nextWorkflowActionForTextCard("review"), "prompt");
  assert.equal(buildPromptOptimizerInput(
    "【最终生成提示词】\n保持建筑不变。\n【禁止项】\n不得扩图。",
    "【不完整提示词优化】\n用户原始提示词：[粘贴原始提示词]"
  ), "【不完整提示词优化】\n用户原始提示词：保持建筑不变。");
});

test("文字结果在来源图片左侧形成可追溯提示词卡", () => {
  const card = createCanvasTextCard({
    kind: "prompt",
    title: "1人视｜提示词",
    text: "【最终生成提示词】\n保持建筑结构不变。",
    sourceVersionId: "version_source",
    taskId: "task_source",
    sourceBounds: { x: 800, y: 200, width: 640, height: 360 },
    now: "2026-08-07T00:00:00.000Z"
  });
  assert.equal(card.x, 268);
  assert.equal(card.y, 200);
  assert.equal(card.sourceVersionId, "version_source");
  assert.equal(card.kind, "prompt");
});

test("提示词卡分别提取继续优化内容与生图所需章节", () => {
  const returned = [
    "【D5调整建议】",
    "调整树木。",
    "【最终生成提示词】",
    "保持建筑结构不变，增加克制景观。",
    "【必须保持与禁止改变】",
    "不得修改窗格。"
  ].join("\n");
  assert.equal(extractFinalPrompt(returned), "保持建筑结构不变，增加克制景观。");
  assert.equal(extractImageGenerationPrompt(returned), [
    "【最终生成提示词】",
    "保持建筑结构不变，增加克制景观。",
    "",
    "【必须保持与禁止改变】",
    "不得修改窗格。"
  ].join("\n"));
});

test("ChatGPT压缩换行时载入生图输入仍排除D5调整建议", () => {
  const collapsed = "编辑【D5调整建议】先调整曝光与玻璃。【最终生成提示词】保持建筑结构不变并优化日景。【必须保持与禁止改变】不得改变体块、道路和相机。";
  assert.equal(extractFinalPrompt(collapsed), "保持建筑结构不变并优化日景。");
  assert.equal(extractImageGenerationPrompt(collapsed), [
    "【最终生成提示词】",
    "保持建筑结构不变并优化日景。",
    "",
    "【必须保持与禁止改变】",
    "不得改变体块、道路和相机。"
  ].join("\n"));
});

test("生图输入剔除禁止项末尾的GPT征询但保留完整结构约束", () => {
  const returned = "【最终生成提示词】保持原图结构并优化日景。【必须保持与禁止改变】如果任何优化会改变硬边，宁可保留原状，也不要执行该项优化。你喜欢此风格吗？";
  assert.equal(extractImageGenerationPrompt(returned), [
    "【最终生成提示词】",
    "保持原图结构并优化日景。",
    "",
    "【必须保持与禁止改变】",
    "如果任何优化会改变硬边，宁可保留原状，也不要执行该项优化。"
  ].join("\n"));
  assert.equal(stripAssistantConversationTail("不得改变建筑结构。如果你愿意，我可以继续提供两个版本。"), "不得改变建筑结构。");
  assert.equal(stripAssistantConversationTail("不得改变建筑结构、道路关系和原始相机。"), "不得改变建筑结构、道路关系和原始相机。");
});

test("返回文字移除来源前缀并拆成可审阅章节", () => {
  const text = "ChatGPT 说：【D5调整建议】\n调整树木。\n【最终生成提示词】\n保持结构不变。";
  assert.equal(normalizeReturnedText(text).startsWith("【D5调整建议】"), true);
  assert.deepEqual(parseReturnedTextSections(text), [
    { id: "section-0", title: "D5调整建议", content: "调整树木。" },
    { id: "section-1", title: "最终生成提示词", content: "保持结构不变。" }
  ]);
});

test("文字卡阶段副标题显示完整工作流名称并兼容旧内容推断", () => {
  assert.equal(inferTextCardWorkflowLabel({
    workflowStage: "scene-optimization",
    action: "prompt",
    hasStyleReference: true
  }), "优化阶段 · 参考风格生成提示词");
  assert.equal(inferTextCardWorkflowLabel({
    kind: "prompt",
    prompt: "【不完整提示词优化】\n用户原始提示词：增强绿化"
  }), "优化阶段 · 继续优化提示词");
  assert.equal(inferTextCardWorkflowLabel({ kind: "review", prompt: "【主要问题】\n构图偏满" }), "阶段一 · 构图与 SU 审查");
});

test("文字卡按画布缩放比例自由调整宽高并保持最小可用尺寸", () => {
  assert.deepEqual(resizedTextCardSize(460, 360, 120, 80, 0.5), { width: 700, height: 520 });
  assert.deepEqual(resizedTextCardSize(460, 360, -1000, -1000), { width: 320, height: 240 });
});

test("玻璃整图只接受相同比例，并生成PS对齐文件名", () => {
  assert.equal(aspectRatiosMatch(3840, 2160, 1536, 864), true);
  assert.equal(aspectRatiosMatch(3840, 2160, 1536, 1024), false);
  assert.equal(alignedGlassFilename("1人视.png"), "1人视_PS对齐.png");
});

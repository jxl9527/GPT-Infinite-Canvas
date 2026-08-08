import assert from "node:assert/strict";
import test from "node:test";
import {
  FIXED_WORKFLOW_PROMPTS,
  fixedWorkflowPromptById,
  workflowStagePrompt
} from "../src/fixed-workflow-prompts.js";

test("画布固定包含七类生产模板和两张通用推进卡", () => {
  assert.equal(FIXED_WORKFLOW_PROMPTS.length, 9);
  assert.equal(new Set(FIXED_WORKFLOW_PROMPTS.map((prompt) => prompt.id)).size, 9);
  assert.equal(FIXED_WORKFLOW_PROMPTS.filter((prompt) => prompt.stage === "stage-3").length, 4);
});

test("阶段三提示词和阶段四整图玻璃模板保持结构保护边界", () => {
  const stageThree = fixedWorkflowPromptById("fixed_stage_3_reference_prompt");
  const stageFour = fixedWorkflowPromptById("fixed_stage_4_glass");
  assert.match(stageThree?.content ?? "", /唯一结构与构图依据/);
  assert.match(stageThree?.content ?? "", /不复制参考建筑/);
  assert.match(stageFour?.content ?? "", /不需要也不得索要蒙版/);
  assert.match(stageFour?.content ?? "", /完整效果图/);
  assert.match(stageFour?.content ?? "", /下部及首层玻璃/);
  assert.match(stageFour?.content ?? "", /上部玻璃/);
  assert.match(stageFour?.content ?? "", /宽高比例/);
});

test("普通 GPT 自包含阶段协议明确区分分析、提示词和生图", () => {
  const stageOne = workflowStagePrompt("stage-1", "analyze");
  const stageThreePrompt = workflowStagePrompt("stage-3", "prompt");
  const stageThreeImage = workflowStagePrompt("stage-3", "generate");
  const stageFour = workflowStagePrompt("stage-4", "generate");
  assert.match(stageOne, /不生成图片/);
  assert.match(stageThreePrompt, /只返回文字/);
  assert.match(stageThreePrompt, /【最终生成提示词】/);
  assert.match(stageThreeImage, /完整画幅/);
  assert.match(stageFour, /不得索要蒙版/);
  assert.match(stageFour, /完整效果图/);
});

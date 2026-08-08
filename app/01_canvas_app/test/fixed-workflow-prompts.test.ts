import assert from "node:assert/strict";
import test from "node:test";
import {
  FIXED_WORKFLOW_PROMPTS,
  fixedWorkflowPromptById,
  workflowStagePrompt
} from "../src/fixed-workflow-prompts.js";

test("固定模板只围绕V3三阶段组织", () => {
  assert.equal(FIXED_WORKFLOW_PROMPTS.length, 7);
  assert.equal(new Set(FIXED_WORKFLOW_PROMPTS.map((prompt) => prompt.id)).size, 7);
  assert.deepEqual(
    [...new Set(FIXED_WORKFLOW_PROMPTS.flatMap((prompt) => prompt.stage ? [prompt.stage] : []))],
    ["preflight", "scene-optimization", "final-glass"]
  );
});

test("前置阶段固定返回构图与SU可见细节文字", () => {
  const prompt = workflowStagePrompt("preflight", "analyze");
  assert.match(prompt, /当前这一张已选定的D5视角/);
  assert.match(prompt, /不与其他视角比较/);
  assert.match(prompt, /【相机与构图调整】/);
  assert.match(prompt, /【SU可见细节】/);
  assert.match(prompt, /无SU截图时/);
  assert.match(prompt, /不生成图片/);
});

test("优化阶段提示词与目标图动作明确分离", () => {
  const promptOnly = workflowStagePrompt("scene-optimization", "prompt");
  const generate = workflowStagePrompt("scene-optimization", "generate");
  assert.match(promptOnly, /只返回文字，不生成图片/);
  assert.match(promptOnly, /【最终生成提示词】/);
  assert.match(generate, /仅用于D5深化参考/);
  assert.match(generate, /不是结构依据或最终交付图/);
});

test("最终阶段整图玻璃模板保持结构和画幅边界", () => {
  const glass = fixedWorkflowPromptById("fixed_final_glass");
  assert.match(glass?.content ?? "", /不需要也不得索要蒙版/);
  assert.match(glass?.content ?? "", /完整效果图/);
  assert.match(glass?.content ?? "", /下部及首层玻璃/);
  assert.match(glass?.content ?? "", /上部玻璃/);
  assert.match(glass?.content ?? "", /每块窗格/);
  assert.match(glass?.content ?? "", /宽高比例/);
});

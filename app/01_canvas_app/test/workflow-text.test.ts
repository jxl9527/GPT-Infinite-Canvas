import assert from "node:assert/strict";
import test from "node:test";
import { MAX_VIEWPOINT_CONCLUSION_LENGTH } from "@gpt-canvas/shared";
import { workflowConclusionFromText } from "../src/workflow-text.js";

test("短审查文字原样写入视角结论", () => {
  assert.equal(workflowConclusionFromText("补充入口窗框后进入 D5。"), "补充入口窗框后进入 D5。");
});

test("长审查文字保留在项目保存上限内", () => {
  const conclusion = workflowConclusionFromText("阶段二审查结论。".repeat(200));
  assert.equal(conclusion.length, MAX_VIEWPOINT_CONCLUSION_LENGTH);
  assert.ok(conclusion.endsWith("…"));
});

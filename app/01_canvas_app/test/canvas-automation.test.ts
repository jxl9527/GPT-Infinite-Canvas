import assert from "node:assert/strict";
import test from "node:test";
import { shouldAutoReturnResults } from "../src/canvas-automation.js";

test("任务完成后自动回收尚未返回的结果", () => {
  assert.equal(shouldAutoReturnResults("completed", 1, 0, false), true);
});

test("生成中、正在回收或全部返回时不重复回收", () => {
  assert.equal(shouldAutoReturnResults("generating", 1, 0, false), false);
  assert.equal(shouldAutoReturnResults("completed", 1, 0, true), false);
  assert.equal(shouldAutoReturnResults("completed", 1, 1, false), false);
});

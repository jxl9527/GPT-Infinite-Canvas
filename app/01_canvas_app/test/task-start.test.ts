import test from "node:test";
import assert from "node:assert/strict";
import { TASK_START_OPTIONS, shouldShowTaskStart } from "../src/task-start.js";

test("task start exposes exactly three independent workflow stages", () => {
  assert.deepEqual(TASK_START_OPTIONS.map((option) => option.stage), [
    "preflight",
    "scene-optimization",
    "final-glass"
  ]);
});

test("task start only appears for a loaded, empty, non-dismissed project", () => {
  assert.equal(shouldShowTaskStart(true, 0, false), true);
  assert.equal(shouldShowTaskStart(false, 0, false), false);
  assert.equal(shouldShowTaskStart(true, 1, false), false);
  assert.equal(shouldShowTaskStart(true, 0, true), false);
});

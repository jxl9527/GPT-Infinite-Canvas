import test from "node:test";
import assert from "node:assert/strict";
import {
  createCanvasHistory,
  moveCanvasHistory,
  pushCanvasHistory,
  type CanvasHistorySnapshot
} from "../src/canvas-history.js";

function snapshot(name: string, x: number): CanvasHistorySnapshot {
  return {
    nodes: [{
      id: `node_${name}`,
      assetId: `asset_${name}`,
      originalRelativePath: `assets/originals/${name}.png`,
      versionId: `version_${name}`,
      origin: "imported",
      parentVersionId: null,
      taskId: null,
      name,
      src: `blob:${name}`,
      sourceWidth: 100,
      sourceHeight: 100,
      x,
      y: 0,
      width: 100,
      height: 100,
      outputRatio: "free"
    }],
    annotations: [],
    structureBaseId: null,
    styleReferenceId: null,
    taskInstruction: ""
  };
}

test("撤销与重做在有限历史中恢复画布状态", () => {
  let history = createCanvasHistory(snapshot("a", 0));
  history = pushCanvasHistory(history, snapshot("a", 20));
  history = pushCanvasHistory(history, snapshot("a", 40));

  const undone = moveCanvasHistory(history, -1);
  assert.equal(undone.snapshot?.nodes[0]?.x, 20);

  const redone = moveCanvasHistory(undone.state, 1);
  assert.equal(redone.snapshot?.nodes[0]?.x, 40);
});

test("撤销后产生新编辑会丢弃旧的重做分支", () => {
  let history = createCanvasHistory(snapshot("a", 0));
  history = pushCanvasHistory(history, snapshot("a", 20));
  history = pushCanvasHistory(history, snapshot("a", 40));
  history = moveCanvasHistory(history, -1).state;
  history = pushCanvasHistory(history, snapshot("a", 25));

  assert.equal(history.entries.length, 3);
  assert.equal(moveCanvasHistory(history, 1).snapshot, null);
});

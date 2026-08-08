import assert from "node:assert/strict";
import test from "node:test";
import type { ImageNodeState } from "../src/canvas-layout.js";
import {
  normalizeSelectionRect,
  selectNodesInRect,
  shouldStartMarqueeOnBackground
} from "../src/marquee-selection.js";

const nodes = [
  { id: "node_1", x: 10, y: 10, width: 100, height: 80 },
  { id: "node_2", x: 10, y: 150, width: 100, height: 80 },
  { id: "node_3", x: 300, y: 10, width: 100, height: 80 }
] as unknown as ImageNodeState[];

test("反向拖动批量框选并选中所有相交图片", () => {
  const rect = normalizeSelectionRect(140, 260, 0, 0);
  assert.deepEqual(selectNodesInRect(nodes, rect).map((node) => node.id), ["node_1", "node_2"]);
});

test("默认选择工具可直接从画布空白处拖出框选", () => {
  assert.equal(shouldStartMarqueeOnBackground("select"), true);
  assert.equal(shouldStartMarqueeOnBackground("marquee"), true);
  assert.equal(shouldStartMarqueeOnBackground("rectangle"), false);
});

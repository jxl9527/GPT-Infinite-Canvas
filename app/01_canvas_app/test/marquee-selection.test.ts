import assert from "node:assert/strict";
import test from "node:test";
import type { ImageNodeState } from "../src/canvas-layout.js";
import {
  normalizeSelectionRect,
  selectMixedCanvasObjectsInRect,
  selectNodesInRect,
  shouldStartMarqueeOnBackground,
  translateSelectedObjects
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

test("同一框选同时包含图片与GPT文字卡", () => {
  const selection = selectMixedCanvasObjectsInRect(
    nodes,
    [
      { id: "text_card_1", x: 130, y: 20, width: 120, height: 100 },
      { id: "text_card_2", x: 420, y: 20, width: 120, height: 100 }
    ],
    normalizeSelectionRect(0, 0, 280, 260)
  );
  assert.deepEqual(selection, {
    imageIds: ["node_1", "node_2"],
    textCardIds: ["text_card_1"]
  });
});

test("批量移动保持图片与文字卡的相对位置", () => {
  const movedImages = translateSelectedObjects(nodes, new Set(["node_1", "node_2"]), 35, -20);
  const cards = [{ id: "text_card_1", x: 130, y: 20, width: 120, height: 100 }];
  const movedCards = translateSelectedObjects(cards, new Set(["text_card_1"]), 35, -20);
  assert.deepEqual(movedImages.slice(0, 2).map(({ x, y }) => ({ x, y })), [
    { x: 45, y: -10 },
    { x: 45, y: 130 }
  ]);
  assert.deepEqual(movedCards.map(({ x, y }) => ({ x, y })), [{ x: 165, y: 0 }]);
});

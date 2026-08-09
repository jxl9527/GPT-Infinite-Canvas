import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCanvasObjectValue,
  encodeCanvasObjectValue
} from "../src/canvas-object-navigation.js";

test("画布对象值可无损编码并支持中文 id", () => {
  const value = encodeCanvasObjectValue("text-card", "text_card_总图提示词");
  assert.deepEqual(decodeCanvasObjectValue(value), {
    kind: "text-card",
    id: "text_card_总图提示词"
  });
});

test("画布对象导航拒绝未知类型、空 id 与换行注入", () => {
  assert.equal(decodeCanvasObjectValue("unknown:node_1"), null);
  assert.equal(decodeCanvasObjectValue("image:"), null);
  assert.equal(decodeCanvasObjectValue(":node_1"), null);
  assert.equal(decodeCanvasObjectValue("annotation:one\ntwo"), null);
});

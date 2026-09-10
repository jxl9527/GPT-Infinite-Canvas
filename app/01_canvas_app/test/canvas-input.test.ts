import assert from "node:assert/strict";
import test from "node:test";
import { canvasKeyboardAction, isMiddleMouseButton } from "../src/canvas-input.js";

test("鼠标中键用于临时漫游", () => {
  assert.equal(isMiddleMouseButton(1), true);
});

test("鼠标左键和右键不触发临时漫游", () => {
  assert.equal(isMiddleMouseButton(0), false);
  assert.equal(isMiddleMouseButton(2), false);
});

test("Escape 始终退出标注，Delete 和 Backspace 删除已选批注", () => {
  assert.equal(canvasKeyboardAction("Escape", {
    editableTarget: true,
    hasSelectedAnnotation: true,
    hasSelectedImage: true,
    modifierPressed: false
  }), "exit-annotation");
  assert.equal(canvasKeyboardAction("Delete", {
    editableTarget: false,
    hasSelectedAnnotation: true,
    hasSelectedImage: true,
    modifierPressed: false
  }), "delete-annotation");
  assert.equal(canvasKeyboardAction("Backspace", {
    editableTarget: false,
    hasSelectedAnnotation: true,
    hasSelectedImage: true,
    modifierPressed: false
  }), "delete-annotation");
});

test("未选批注但选中图片时 Delete 删除图片节点", () => {
  assert.equal(canvasKeyboardAction("Delete", {
    editableTarget: false,
    hasSelectedAnnotation: false,
    hasSelectedImage: true,
    modifierPressed: false
  }), "delete-image");
});

test("输入框和组合键不会误触发删除或工具快捷键", () => {
  assert.equal(canvasKeyboardAction("Delete", {
    editableTarget: true,
    hasSelectedAnnotation: true,
    hasSelectedImage: true,
    modifierPressed: false
  }), null);
  assert.equal(canvasKeyboardAction("a", {
    editableTarget: false,
    hasSelectedAnnotation: false,
    hasSelectedImage: true,
    modifierPressed: true
  }), null);
  assert.equal(canvasKeyboardAction("p", {
    editableTarget: false,
    hasSelectedAnnotation: false,
    hasSelectedImage: false,
    modifierPressed: false
  }), "tool-freehand");
  assert.equal(canvasKeyboardAction("m", {
    editableTarget: false,
    hasSelectedAnnotation: false,
    hasSelectedImage: false,
    modifierPressed: false
  }), "tool-marquee");
});

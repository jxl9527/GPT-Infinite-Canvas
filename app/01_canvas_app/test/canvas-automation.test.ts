import assert from "node:assert/strict";
import test from "node:test";
import {
  automationExtensionReady,
  automationExtensionVersion,
  automationExtensionVersionSupported,
  generationPlaceholderBounds,
  shouldShowImageGenerationPlaceholder,
  shouldAutoReturnResults
} from "../src/canvas-automation.js";

test("读取真实扩展版本并拦截未重载的旧版本", () => {
  assert.equal(automationExtensionVersion("1.5.20", "任意消息"), "1.5.20");
  assert.equal(automationExtensionVersion(null, "全自动桥接扩展 1.5.4 已连接"), "1.5.4");
  assert.equal(automationExtensionVersionSupported("1.5.16"), false);
  assert.equal(automationExtensionVersionSupported("1.5.17"), false);
  assert.equal(automationExtensionVersionSupported("1.5.18"), false);
  assert.equal(automationExtensionVersionSupported("1.5.19"), false);
  assert.equal(automationExtensionVersionSupported("1.5.20"), true);
  assert.equal(automationExtensionVersionSupported("1.6.0"), true);
  assert.equal(automationExtensionReady("ready", "1.5.16"), false);
  assert.equal(automationExtensionReady("started", "1.5.17"), false);
  assert.equal(automationExtensionReady("started", "1.5.18"), false);
  assert.equal(automationExtensionReady("started", "1.5.19"), false);
  assert.equal(automationExtensionReady("started", "1.5.20"), true);
});

test("任务完成后自动回收尚未返回的结果", () => {
  assert.equal(shouldAutoReturnResults("completed", 1, 0, false), true);
});

test("生成中、正在回收或全部返回时不重复回收", () => {
  assert.equal(shouldAutoReturnResults("generating", 1, 0, false), false);
  assert.equal(shouldAutoReturnResults("completed", 1, 0, true), false);
  assert.equal(shouldAutoReturnResults("completed", 1, 1, false), false);
});

test("图片任务从创建到回收前显示生成占位框，取消或真实节点返回后隐藏", () => {
  assert.equal(shouldShowImageGenerationPlaceholder("queued", "image", 0, false), true);
  assert.equal(shouldShowImageGenerationPlaceholder("generating", "image", 0, false), true);
  assert.equal(shouldShowImageGenerationPlaceholder("completed", "image", 1, false), true);
  assert.equal(shouldShowImageGenerationPlaceholder("completed", "image", 1, true), false);
  assert.equal(shouldShowImageGenerationPlaceholder("cancelled", "image", 0, false), false);
  assert.equal(shouldShowImageGenerationPlaceholder("generating", "text", 0, false), false);
});

test("生成占位框与正式结果使用相同的父图右侧位置", () => {
  assert.deepEqual(
    generationPlaceholderBounds({ x: 120, y: 80, width: 640, height: 360 }),
    { x: 856, y: 80, width: 640, height: 360 }
  );
});

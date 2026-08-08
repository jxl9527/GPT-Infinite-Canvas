import assert from "node:assert/strict";
import test from "node:test";
import {
  automationExtensionReady,
  automationExtensionVersion,
  automationExtensionVersionSupported,
  shouldAutoReturnResults
} from "../src/canvas-automation.js";

test("读取真实扩展版本并拦截未重载的旧版本", () => {
  assert.equal(automationExtensionVersion("1.5.16", "任意消息"), "1.5.16");
  assert.equal(automationExtensionVersion(null, "全自动桥接扩展 1.5.4 已连接"), "1.5.4");
  assert.equal(automationExtensionVersionSupported("1.5.15"), false);
  assert.equal(automationExtensionVersionSupported("1.5.16"), true);
  assert.equal(automationExtensionVersionSupported("1.6.0"), true);
  assert.equal(automationExtensionReady("ready", "1.5.15"), false);
  assert.equal(automationExtensionReady("started", "1.5.16"), true);
});

test("任务完成后自动回收尚未返回的结果", () => {
  assert.equal(shouldAutoReturnResults("completed", 1, 0, false), true);
});

test("生成中、正在回收或全部返回时不重复回收", () => {
  assert.equal(shouldAutoReturnResults("generating", 1, 0, false), false);
  assert.equal(shouldAutoReturnResults("completed", 1, 0, true), false);
  assert.equal(shouldAutoReturnResults("completed", 1, 1, false), false);
});

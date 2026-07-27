import test from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION, type GenerationTask } from "../src/protocol.js";
import { isAutoBindableTaskPage, isBindableTaskPage, isCanvasTriggerUrl, isChatGptUrl, isTrustedTaskMessage, shouldFocusChatForHandoff, statusForAdapterEvent } from "../src/background-guards.js";

const task: GenerationTask = {
  schemaVersion: SCHEMA_VERSION,
  id: "task_20260723_example",
  idempotencyKey: "idempotency",
  taskType: "edit",
  target: { chatMode: "new" },
  prompt: "保持结构不变",
  attachments: [],
  status: "generating",
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:01.000Z",
  submittedAt: "2026-07-23T00:00:01.000Z",
  events: [],
  results: []
};

test("页面事件只接受同任务且同绑定标签页", () => {
  const binding = "binding-1234567890";
  assert.equal(isTrustedTaskMessage(task, task.id, 10, "https://chatgpt.com/", binding, binding), true);
  assert.equal(isTrustedTaskMessage(task, "task_wrong", 10, "https://chatgpt.com/", binding, binding), false);
  assert.equal(isTrustedTaskMessage(task, task.id, 11, "https://example.com/", binding, binding), false);
  assert.equal(isTrustedTaskMessage(task, task.id, 11, "https://chatgpt.com/", "wrong-binding-123", binding), false);
  assert.equal(isTrustedTaskMessage({ ...task, status: "completed" }, task.id, 10, "https://chatgpt.com/", binding, binding), false);
});

test("Adapter 事件统一映射到共享协议状态", () => {
  assert.equal(statusForAdapterEvent("upload-started"), "uploading");
  assert.equal(statusForAdapterEvent("submitted"), "submitted");
  assert.equal(statusForAdapterEvent("unknown"), undefined);
});

test("只识别 ChatGPT HTTPS 页面", () => {
  assert.equal(isChatGptUrl("https://chatgpt.com/c/example"), true);
  assert.equal(isChatGptUrl("https://chat.openai.com/"), true);
  assert.equal(isChatGptUrl("http://chatgpt.com/"), false);
  assert.equal(isChatGptUrl("https://example.com/"), false);
});

test("全自动任务只接受固定本地画布来源", () => {
  assert.equal(isCanvasTriggerUrl("http://127.0.0.1:3230/"), true);
  assert.equal(isCanvasTriggerUrl("http://localhost:3230/project"), true);
  assert.equal(isCanvasTriggerUrl("http://127.0.0.1:3220/"), false);
  assert.equal(isCanvasTriggerUrl("https://127.0.0.1:3230/"), false);
  assert.equal(isCanvasTriggerUrl("https://example.com/"), false);
});

test("只有非终态任务和明确的 ChatGPT 标签页可以主动重绑", () => {
  assert.equal(isBindableTaskPage(task, 12, "https://chatgpt.com/"), true);
  assert.equal(isBindableTaskPage(task, undefined, "https://chatgpt.com/"), false);
  assert.equal(isBindableTaskPage(task, 12, "https://example.com/"), false);
  assert.equal(isBindableTaskPage({ ...task, status: "completed" }, 12, "https://chatgpt.com/"), false);
});

test("自动自愈绑定只允许正在打开 ChatGPT 的任务", () => {
  const { submittedAt: _submittedAt, ...taskBeforeSubmit } = task;
  const openingTask: GenerationTask = { ...taskBeforeSubmit, status: "opening-chat" };
  assert.equal(isAutoBindableTaskPage(openingTask, 12, "https://chatgpt.com/"), true);
  assert.equal(isAutoBindableTaskPage({ ...task, status: "uploading" }, 12, "https://chatgpt.com/"), false);
  assert.equal(isAutoBindableTaskPage(openingTask, undefined, "https://chatgpt.com/"), false);
  assert.equal(isAutoBindableTaskPage(openingTask, 12, "https://example.com/"), false);
});

test("只有登录或网页验证失效时才把 ChatGPT 切到前台", () => {
  assert.equal(shouldFocusChatForHandoff("等待 ChatGPT 输入区超时；请检查登录状态或网页验证"), true);
  assert.equal(shouldFocusChatForHandoff("Please sign in to continue"), true);
  assert.equal(shouldFocusChatForHandoff("结果收集失败：图片解码异常"), false);
  assert.equal(shouldFocusChatForHandoff(undefined), false);
});

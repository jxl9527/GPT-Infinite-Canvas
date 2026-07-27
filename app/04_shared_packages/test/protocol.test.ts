import test from "node:test";
import assert from "node:assert/strict";
import {
  ProtocolError,
  STATUS_TRANSITIONS,
  canTransition,
  isTerminalStatus,
  parseCreateTaskInput
} from "../src/index.js";

test("状态机禁止已提交任务回退和终态变化", () => {
  assert.equal(canTransition("submitted", "ready-to-submit"), false);
  assert.equal(canTransition("ready-to-submit", "uploading"), true);
  for (const terminal of ["completed", "failed", "cancelled"] as const) {
    assert.equal(isTerminalStatus(terminal), true);
    assert.deepEqual(STATUS_TRANSITIONS[terminal], []);
  }
});

test("已有会话必须使用有效 ChatGPT 地址", () => {
  assert.throws(
    () => parseCreateTaskInput({ taskType: "edit", target: { chatMode: "existing", chatUrl: "https://example.com" }, prompt: "测试任务", attachments: [] }),
    (error) => error instanceof ProtocolError && error.code === "CHAT_URL_INVALID"
  );
  const parsed = parseCreateTaskInput({
    taskType: "edit",
    target: { chatMode: "existing", chatUrl: "https://chatgpt.com/c/example" },
    prompt: "保持建筑结构不变",
    attachments: []
  });
  assert.equal(parsed.target.chatMode, "existing");
});

test("任务最多接受两个已声明角色的附件", () => {
  assert.throws(
    () => parseCreateTaskInput({
      taskType: "edit", target: { chatMode: "new" }, prompt: "测试附件数量",
      attachments: Array.from({ length: 3 }, (_, index) => ({ role: "edit-target", name: `${index}.png`, relativePath: `assets/${index}.png` }))
    }),
    (error) => error instanceof ProtocolError && error.code === "INVALID_ATTACHMENT"
  );
});

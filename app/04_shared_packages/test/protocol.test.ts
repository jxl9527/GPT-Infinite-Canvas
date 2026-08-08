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
  assert.equal(canTransition("submitted", "cancelled"), true);
  assert.equal(canTransition("generating", "cancelled"), true);
  assert.equal(canTransition("collecting", "cancelled"), true);
  assert.equal(canTransition("ready-to-submit", "uploading"), true);
  for (const terminal of ["completed", "failed", "cancelled"] as const) {
    assert.equal(isTerminalStatus(terminal), true);
    assert.deepEqual(STATUS_TRANSITIONS[terminal], []);
  }
});

test("已有会话必须使用与生成来源匹配的地址", () => {
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
  assert.equal(parsed.target.provider, "chatgpt");

  const flow = parseCreateTaskInput({
    taskType: "edit",
    target: {
      provider: "google-flow",
      chatMode: "existing",
      chatUrl: "https://labs.google/fx/zh/tools/flow/project/example",
      localProject: { id: "project_example", name: "物流基地" },
      outputCount: 4
    },
    prompt: "保持建筑结构不变",
    attachments: []
  });
  assert.equal(flow.target.provider, "google-flow");
  assert.equal(flow.target.outputCount, 4);
  assert.throws(
    () => parseCreateTaskInput({
      taskType: "edit",
      target: {
        provider: "google-flow",
        chatMode: "new",
        localProject: { id: "project_example", name: "物流基地" },
        outputCount: 5
      },
      prompt: "输出数量无效",
      attachments: []
    }),
    (error) => error instanceof ProtocolError && error.code === "INVALID_INPUT"
  );
  assert.throws(
    () => parseCreateTaskInput({
      taskType: "edit",
      target: {
        provider: "google-flow",
        chatMode: "existing",
        chatUrl: "https://chatgpt.com/c/example",
        localProject: { id: "project_example", name: "物流基地" }
      },
      prompt: "来源与网址不匹配",
      attachments: []
    }),
    (error) => error instanceof ProtocolError && error.code === "CHAT_URL_INVALID"
  );
});

test("阶段任务最多接受三个已声明角色的附件", () => {
  const parsed = parseCreateTaskInput({
    taskType: "edit", responseMode: "text", target: { chatMode: "new" }, prompt: "对比三个候选视角",
    attachments: Array.from({ length: 3 }, (_, index) => ({ role: "content-reference", name: `${index}.png`, relativePath: `assets/${index}.png` }))
  });
  assert.equal(parsed.attachments.length, 3);
  assert.equal(parsed.responseMode, "text");
  assert.throws(
    () => parseCreateTaskInput({
      taskType: "edit", target: { chatMode: "new" }, prompt: "测试附件数量",
      attachments: Array.from({ length: 4 }, (_, index) => ({ role: "edit-target", name: `${index}.png`, relativePath: `assets/${index}.png` }))
    }),
    (error) => error instanceof ProtocolError && error.code === "INVALID_ATTACHMENT"
  );
  assert.throws(
    () => parseCreateTaskInput({
      taskType: "edit", responseMode: "video", target: { chatMode: "new" }, prompt: "无效结果类型", attachments: []
    }),
    (error) => error instanceof ProtocolError && error.code === "INVALID_INPUT"
  );
});

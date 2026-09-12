import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCreateTaskInput, type CreateTaskInput } from "@gpt-canvas/shared";
import { TaskStore } from "../src/task-store.js";

function input(item: string, concurrency: 1 | 2 = 2): CreateTaskInput {
  return { taskType: "edit", target: { chatMode: "new" }, prompt: "直接生图", attachments: [], simpleRender: { batchId: "simple_batch", itemId: `item_${item}`, sourceVersionId: `version_${item}`, concurrency } };
}
async function submitted(store: TaskStore, id: string) { await store.claim(id); await store.transition(id, "ready-to-submit", "test"); await store.transition(id, "submitted", "test"); }

test("双任务服务锁：有序提交、最多两个、旧任务隔离、幂等恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "canvas-simple-pool-"));
  const store = new TaskStore(root); await store.init();
  const a = await store.create(input("a"), []);
  await assert.rejects(() => store.create(input("b"), []), /等待上一张/);
  await submitted(store, a.id);
  const b = await store.create(input("b"), []); await submitted(store, b.id);
  await assert.rejects(() => store.create(input("c"), []), /位置已占用/);
  await assert.rejects(() => store.create({ taskType: "edit", target: { chatMode: "new" }, prompt: "旧版", attachments: [] }, []), /位置已占用/);
  assert.equal((await store.create(input("b"), [])).id, b.id);
  await assert.rejects(() => store.create({ ...input("b"), prompt: "不同提示词" }, []), /已改变/);
  const recovered = new TaskStore(root); await recovered.init();
  assert.equal(recovered.list().length, 2); assert.ok(recovered.get(a.id)?.submittedAt);
  await recovered.transition(b.id, "cancelled", "user");
  const c = await recovered.create(input("c"), []); assert.ok(c.id);
  assert.equal(recovered.get(a.id)?.status, "submitted");
});

test("单任务回退与异常暂停保持底层约束", async () => {
  const store = new TaskStore(await mkdtemp(join(tmpdir(), "canvas-simple-single-"))); await store.init();
  const a = await store.create(input("a", 1), []); await submitted(store, a.id);
  await assert.rejects(() => store.create(input("b", 1), []), /位置已占用/);
  await assert.rejects(() => store.create(input("b", 2), []), /位置已占用/);
  await store.handoff(a.id, "登录验证", []);
  await assert.rejects(() => store.create(input("b", 1), []));
});

test("并发合同拒绝三并发、多附件和已有会话", () => {
  const valid = { ...input("a"), attachments: [{ role: "structure-base", name: "a.png", relativePath: "assets/a.png" }] };
  assert.equal(parseCreateTaskInput(valid).simpleRender?.concurrency, 2);
  assert.throws(() => parseCreateTaskInput({ ...valid, simpleRender: { ...valid.simpleRender, concurrency: 3 } }));
  assert.throws(() => parseCreateTaskInput({ ...valid, attachments: [...valid.attachments, ...valid.attachments] }));
  assert.throws(() => parseCreateTaskInput({ ...valid, target: { chatMode: "existing", chatUrl: "https://chatgpt.com/c/test" } }));
});

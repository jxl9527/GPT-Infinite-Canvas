import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtocolError, type CreateTaskInput, type GenerationResult } from "@gpt-canvas/shared";
import { TaskStore } from "../src/task-store.js";

const input: CreateTaskInput = {
  taskType: "edit",
  target: { chatMode: "new" },
  prompt: "保持建筑数量、体块关系和场地边界不变",
  attachments: []
};

async function temporaryStore(): Promise<{ root: string; store: TaskStore }> {
  const root = await mkdtemp(join(tmpdir(), "gpt-canvas-p1-store-"));
  const store = new TaskStore(root); await store.init(); return { root, store };
}

test("严格串行、不可逆提交和 SHA-256 结果去重", async () => {
  const { root, store } = await temporaryStore(); const task = await store.create(input, []);
  await assert.rejects(() => store.create(input, []), (error) => error instanceof ProtocolError && error.code === "TASK_LOCKED");
  await store.claim(task.id, "test");
  await store.transition(task.id, "ready-to-submit", "test");
  await store.transition(task.id, "submitted", "test");
  await assert.rejects(
    () => store.transition(task.id, "ready-to-submit", "test"),
    (error) => error instanceof ProtocolError && error.code === "INVALID_TRANSITION"
  );
  await store.transition(task.id, "generating", "test");
  await store.transition(task.id, "collecting", "test");
  const resultBytes = Buffer.from("verified-result");
  const resultRoot = join(root, "runs", task.id, "results"); await mkdir(resultRoot, { recursive: true });
  await writeFile(join(resultRoot, "result.png"), resultBytes);
  const result: GenerationResult = {
    id: randomUUID(), createdAt: new Date().toISOString(), filename: "result.png", mime: "image/png",
    bytes: resultBytes.byteLength,
    sha256: createHash("sha256").update(resultBytes).digest("hex"),
    relativePath: `runs/${task.id}/results/result.png`, source: "visible-page"
  };
  assert.equal((await store.addResult(task.id, result)).deduplicated, false);
  assert.equal((await store.addResult(task.id, { ...result, id: randomUUID() })).deduplicated, true);
  const completed = await store.complete(task.id, "test");
  assert.equal(completed.status, "completed");
  assert.equal(completed.results.length, 1);
});

test("完成前重新核验结果文件，文件被改动时保持 collecting", async () => {
  const { root, store } = await temporaryStore(); const task = await store.create(input, []);
  await store.claim(task.id, "test"); await store.transition(task.id, "ready-to-submit", "test");
  await store.transition(task.id, "submitted", "test"); await store.transition(task.id, "collecting", "test");
  const original = Buffer.from("original-result"); const resultRoot = join(root, "runs", task.id, "results");
  await mkdir(resultRoot, { recursive: true }); await writeFile(join(resultRoot, "result.png"), original);
  await store.addResult(task.id, {
    id: randomUUID(), createdAt: new Date().toISOString(), filename: "result.png", mime: "image/png",
    bytes: original.byteLength, sha256: createHash("sha256").update(original).digest("hex"),
    relativePath: `runs/${task.id}/results/result.png`, source: "visible-page"
  });
  await writeFile(join(resultRoot, "result.png"), Buffer.from("tampered-result"));
  await assert.rejects(
    () => store.complete(task.id, "test"),
    (error) => error instanceof ProtocolError && error.code === "RECOVERY_REQUIRED"
  );
  assert.equal(store.get(task.id)?.status, "collecting");
});

test("服务重启后恢复未完成任务及已提交锁", async () => {
  const { root, store } = await temporaryStore(); const task = await store.create(input, []);
  await store.claim(task.id, "test"); await store.transition(task.id, "ready-to-submit", "test");
  const submitted = await store.transition(task.id, "submitted", "test");
  const recovered = new TaskStore(root); await recovered.init();
  assert.equal(recovered.getActive()?.id, task.id);
  assert.equal(recovered.get(task.id)?.submittedAt, submitted.submittedAt);
  await assert.rejects(() => recovered.create(input, []), (error) => error instanceof ProtocolError && error.code === "TASK_LOCKED");
});

test("文字审查任务保存结论后可以完成且不要求图片", async () => {
  const { root, store } = await temporaryStore();
  const task = await store.create({ ...input, responseMode: "text" }, []);
  await store.claim(task.id, "test"); await store.transition(task.id, "ready-to-submit", "test");
  await store.transition(task.id, "submitted", "test"); await store.transition(task.id, "collecting", "test");
  const text = "## 阶段一结论\n\n建议保留A视角，并轻微增加焦距。\n";
  const bytes = Buffer.from(text, "utf8");
  const resultRoot = join(root, "runs", task.id, "results"); await mkdir(resultRoot, { recursive: true });
  await writeFile(join(resultRoot, "assistant-response.md"), bytes);
  await store.addTextResult(task.id, {
    id: randomUUID(), createdAt: new Date().toISOString(), text: text.trim(), bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    relativePath: `runs/${task.id}/results/assistant-response.md`, source: "visible-page"
  });
  const completed = await store.complete(task.id, "test");
  assert.equal(completed.status, "completed");
  assert.equal(completed.results.length, 0);
  assert.match(completed.textResult?.text ?? "", /建议保留A视角/);
});

test("用户可结束已提交任务并创建下一项任务", async () => {
  const { store } = await temporaryStore();
  const task = await store.create(input, []);
  await store.claim(task.id, "test");
  await store.transition(task.id, "ready-to-submit", "test");
  await store.transition(task.id, "submitted", "test");
  await store.transition(task.id, "generating", "test");
  const cancelled = await store.transition(task.id, "cancelled", "user", "用户结束本地跟踪");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(store.getActive(), undefined);
  assert.ok(await store.create(input, []));
});

test("带提交记账的异常 ready-to-submit 状态不得回退重传附件", async () => {
  const { root, store } = await temporaryStore(); const task = await store.create(input, []);
  await store.claim(task.id, "test"); await store.transition(task.id, "ready-to-submit", "test");
  const path = join(root, "tasks", task.id, "task.json");
  const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  persisted.submittedAt = new Date().toISOString(); await writeFile(path, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  const recovered = new TaskStore(root); await recovered.init();
  await assert.rejects(
    () => recovered.transition(task.id, "uploading", "test"),
    (error) => error instanceof ProtocolError && error.code === "ALREADY_SUBMITTED"
  );
});

test("人工接管跨服务重启恢复，提交锁和任务数据保持不变", async () => {
  const { root, store } = await temporaryStore(); const task = await store.create(input, []);
  await store.claim(task.id, "extension");
  const preSubmitHandoff = await store.handoff(task.id, "上传控件暂不可用", ["queued", "opening-chat"], "extension");
  assert.equal(preSubmitHandoff.status, "needs-user"); assert.equal(preSubmitHandoff.submittedAt, undefined);

  const firstRecovery = new TaskStore(root); await firstRecovery.init();
  assert.equal(firstRecovery.getActive()?.id, task.id);
  await firstRecovery.transition(task.id, "uploading", "recovery");
  await firstRecovery.transition(task.id, "ready-to-submit", "recovery");
  const submitted = await firstRecovery.transition(task.id, "submitted", "extension");
  const postSubmitHandoff = await firstRecovery.handoff(task.id, "生成页面刷新", submitted.events.map((item) => item.status), "extension");
  assert.equal(postSubmitHandoff.status, "needs-user"); assert.ok(postSubmitHandoff.submittedAt);

  const secondRecovery = new TaskStore(root); await secondRecovery.init();
  await assert.rejects(
    () => secondRecovery.transition(task.id, "submitted", "recovery"),
    (error) => error instanceof ProtocolError && error.code === "ALREADY_SUBMITTED"
  );
  const collecting = await secondRecovery.transition(task.id, "collecting", "recovery");
  assert.equal(collecting.id, task.id); assert.equal(collecting.submittedAt, submitted.submittedAt);
  assert.equal(collecting.events.filter((item) => item.status === "submitted").length, 1);
});

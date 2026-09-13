import test from "node:test";
import assert from "node:assert/strict";
import type { CanvasImageAsset, GenerationTask } from "@gpt-canvas/shared";
import type { CanvasProjectDocument } from "../src/project-state.js";
import { appendImage, appendSimpleVariant, batchFinished, boundsOverlap, makeSimpleBatch, nextSimpleItem, pendingSlots, retrySimpleItem, simpleBlockingTask, simpleSlotBounds, simpleTaskInput } from "../src/simple-state.js";

const asset: CanvasImageAsset = { id: "asset_a", originalName: "建筑.png", kind: "imported", createdAt: "now", original: { width: 1200, height: 800, relativePath: "assets/originals/a.png", mime: "image/png", bytes: 100, sha256: "a".repeat(64) } };
const blank = (): CanvasProjectDocument => ({ schemaVersion: "2.0", projectId: "project_123", title: "建筑", createdAt: "now", updatedAt: "now", revision: 0, canvas: { viewport: { x: 0, y: 0, scale: 1 }, nodes: [] }, assets: [], versions: [], taskLinks: [] });

test("简化批次只冻结显式选图和全文提示词，不附加阶段与封面", () => {
  let doc = appendImage(blank(), asset, "图A"); doc = appendImage(doc, asset, "图B");
  const prompt = "用户提示词\n" + "保护结构。".repeat(600);
  const batch = makeSimpleBatch(doc, [doc.canvas.nodes[1]!.id], prompt, 2);
  doc.canvas.nodes[1]!.payload.name = "改名";
  assert.equal(batch.items.length, 1); assert.equal(batch.items[0]!.sourceName, "图B");
  const input = simpleTaskInput(doc, batch, batch.items[0]!, "project_abc");
  assert.equal(input.prompt, prompt); assert.equal(input.attachments.length, 1); assert.equal(input.target.chatMode, "new");
  assert.equal(input.simpleRender!.sourceVersionId, doc.versions[1]!.id);
  assert.throws(() => makeSimpleBatch(doc, [], prompt, 2)); assert.throws(() => makeSimpleBatch(doc, [doc.canvas.nodes[0]!.id], " ", 2));
});

test("双任务排程等待前项提交，第二项先完成可补位，暂停与异常不新发", () => {
  let doc = blank(); for (let i=0;i<3;i++) doc = appendImage(doc, asset, `图${i}`);
  const batch = makeSimpleBatch(doc, doc.canvas.nodes.map((n) => n.id), "生成图片", 2);
  const tasks = batch.items.slice(0,2).map((item, index) => ({ id: `task_${index}`, simpleRender: { batchId: batch.id, itemId: item.id }, status: "generating", submittedAt: "now" })) as GenerationTask[];
  assert.equal(nextSimpleItem(batch, tasks), null);
  tasks[1]!.status = "completed"; assert.equal(nextSimpleItem(batch, tasks)?.id, batch.items[2]!.id);
  delete tasks[0]!.submittedAt; assert.equal(nextSimpleItem(batch, tasks), null);
  tasks[0]!.submittedAt = "now"; tasks[0]!.status = "needs-user"; assert.equal(nextSimpleItem(batch, tasks), null);
  tasks[0]!.status = "generating"; batch.paused = true; assert.equal(nextSimpleItem(batch, tasks), null);
});

test("占用生成名额的非本批任务被识别为锁，完成或取消后解除", () => {
  let doc = blank(); doc = appendImage(doc, asset, "图A");
  const batch = makeSimpleBatch(doc, doc.canvas.nodes.map((n) => n.id), "生成图片", 2);
  const own = { id: "task_own", simpleRender: { batchId: batch.id, itemId: batch.items[0]!.id }, status: "generating" } as unknown as GenerationTask;
  assert.equal(simpleBlockingTask(batch, [own]), null);
  const legacy = { id: "task_legacy", status: "submitted" } as unknown as GenerationTask;
  assert.equal(simpleBlockingTask(batch, [own, legacy])?.id, "task_legacy");
  legacy.status = "completed"; assert.equal(simpleBlockingTask(batch, [own, legacy]), null);
  const otherBatch = { id: "task_other", simpleRender: { batchId: "simple_other", itemId: "item_x" }, status: "generating" } as unknown as GenerationTask;
  assert.equal(simpleBlockingTask(batch, [otherBatch])?.id, "task_other");
  otherBatch.status = "cancelled"; assert.equal(simpleBlockingTask(batch, [otherBatch]), null);
});

test("乱序结果按父图右置且幂等，保留旧批注与版本", () => {
  let doc = appendImage(blank(), asset, "图A"); doc = appendImage(doc, asset, "图B");
  const oldNode = structuredClone(doc.canvas.nodes[0]);
  doc = appendImage(doc, asset, "B结果", { versionId: "version_resultB", parentVersionId: doc.versions[1]!.id, taskId: "task_B" });
  const before = structuredClone(doc);
  assert.deepEqual(appendImage(doc, asset, "B结果", { versionId: "version_resultB" }), before);
  doc = appendImage(doc, asset, "A结果", { versionId: "version_resultA", parentVersionId: doc.versions[0]!.id, taskId: "task_A" });
  assert.deepEqual(doc.canvas.nodes[0], oldNode); assert.equal(doc.versions[2]!.parentVersionId, doc.versions[1]!.id);
  assert.ok(doc.canvas.nodes[2]!.x > doc.canvas.nodes[1]!.x + doc.canvas.nodes[1]!.width);
  assert.deepEqual(doc.taskLinks.map((link) => link.taskId), ["task_B", "task_A"]);
});

test("同图多版本按轮次展开并分配稳定序号", () => {
  let doc = blank(); for (let i = 0; i < 2; i++) doc = appendImage(doc, asset, `图${i}`);
  const ids = doc.canvas.nodes.map((node) => node.id);
  const batch = makeSimpleBatch(doc, ids, "生成图片", 2, 3);
  assert.equal(batch.items.length, 6);
  assert.deepEqual(batch.items.map((item) => `${item.sourceName}V${item.variantOrdinal}`), ["图0V1", "图1V1", "图0V2", "图1V2", "图0V3", "图1V3"]);
  assert.equal(new Set(batch.items.map((item) => item.id)).size, 6);
  let many = blank(); for (let i = 0; i < 67; i++) many = appendImage(many, asset, `图${i}`);
  assert.throws(() => makeSimpleBatch(many, many.canvas.nodes.map((node) => node.id), "生成图片", 2, 3));
});

test("活动批次追加版本继续编号并保持冻结提示词", () => {
  let doc = blank(); doc = appendImage(doc, asset, "图A");
  const batch = makeSimpleBatch(doc, doc.canvas.nodes.map((node) => node.id), "冻结提示词", 2, 1);
  const sourceVersionId = doc.versions[0]!.id;
  const next = appendSimpleVariant(batch, sourceVersionId, 1);
  assert.equal(next.items.length, 2);
  assert.equal(next.items[1]!.variantOrdinal, 2);
  assert.equal(next.items[1]!.sourceVersionId, sourceVersionId);
  assert.equal(next.items[1]!.clonedFromItemId, batch.items[0]!.id);
  assert.equal(next.prompt, "冻结提示词");
  assert.equal(next.paused, batch.paused);
  assert.deepEqual(batch.items.length, 1);
  assert.throws(() => appendSimpleVariant(batch, "version_missing"));
});

test("失败项补生建立新任务且不覆盖旧记录", () => {
  let doc = blank(); doc = appendImage(doc, asset, "图A");
  const batch = makeSimpleBatch(doc, doc.canvas.nodes.map((node) => node.id), "生成图片", 2, 1);
  const failedId = batch.items[0]!.id;
  batch.items[0]!.status = "failed"; batch.items[0]!.error = "任务未完成";
  const { batch: next, replacementId, wasCancelled } = retrySimpleItem(batch, failedId);
  assert.equal(wasCancelled, false);
  const old = next.items.find((item) => item.id === failedId)!;
  assert.equal(old.status, "failed"); assert.equal(old.error, "任务未完成"); assert.equal(old.supersededByItemId, replacementId);
  const replacement = next.items.find((item) => item.id === replacementId)!;
  assert.equal(replacement.status, "queued"); assert.equal(replacement.retryOfItemId, failedId); assert.equal(replacement.variantOrdinal, 2);
  assert.equal(batchFinished(next), false);
  assert.equal(nextSimpleItem(next, [])?.id, replacementId);
  next.items = next.items.map((item) => item.id === replacementId ? { ...item, status: "completed" as const } : item);
  assert.equal(batchFinished(next), true);
  const stopped = makeSimpleBatch(doc, doc.canvas.nodes.map((node) => node.id), "生成图片", 2, 1);
  stopped.items[0]!.status = "cancelled";
  assert.equal(retrySimpleItem(stopped, stopped.items[0]!.id).wasCancelled, true);
});

test("同源占位槽位依次递增并排除已完成与已替代项", () => {
  let doc = blank(); for (let i = 0; i < 2; i++) doc = appendImage(doc, asset, `图${i}`);
  const batch = makeSimpleBatch(doc, doc.canvas.nodes.map((node) => node.id), "生成图片", 2, 2);
  const items = batch.items;
  items[0]!.status = "completed";
  items[3]!.supersededByItemId = "item_x";
  const slots = pendingSlots(items);
  assert.equal(slots.size, 2);
  assert.equal(slots.get(items[1]!.id), 0);
  assert.equal(slots.get(items[2]!.id), 0);
  assert.equal(slots.has(items[0]!.id), false);
  assert.equal(slots.has(items[3]!.id), false);
});

test("结果按预留槽位向下排列，槽位重叠时判定为不可用", () => {
  const parent = { x: 0, y: 0, width: 200, height: 150 };
  const siblings = [{ x: 296, y: 0, width: 200, height: 150 }, { x: 296, y: 198, width: 200, height: 150 }];
  const size = { width: 200, height: 150 };
  const slot0 = simpleSlotBounds(parent, siblings, 0, size);
  const slot1 = simpleSlotBounds(parent, siblings, 1, size);
  assert.equal(slot0.x, 296); assert.equal(slot0.y, 396);
  assert.equal(slot1.y, 594);
  assert.equal(boundsOverlap(slot0, siblings), false);
  assert.equal(boundsOverlap(slot0, [{ x: 296, y: 396, width: 200, height: 150 }]), true);
});

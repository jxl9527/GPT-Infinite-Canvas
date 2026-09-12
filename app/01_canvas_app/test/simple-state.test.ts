import test from "node:test";
import assert from "node:assert/strict";
import type { CanvasImageAsset, GenerationTask } from "@gpt-canvas/shared";
import type { CanvasProjectDocument } from "../src/project-state.js";
import { appendImage, makeSimpleBatch, nextSimpleItem, simpleTaskInput } from "../src/simple-state.js";

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

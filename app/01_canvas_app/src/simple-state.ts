import type { CanvasImageAsset, CreateTaskInput, GenerationTask } from "@gpt-canvas/shared";
import type { CanvasProjectDocument } from "./project-state.js";
import { fitImportedImage, nextChildBoundsToRight } from "./canvas-layout.js";

export interface SimpleItem {
  id: string;
  sourceVersionId: string;
  sourceName: string;
  taskId: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  resultVersionIds: string[];
  error: string;
}
export interface SimpleBatch {
  id: string;
  prompt: string;
  concurrency: 1 | 2;
  paused: boolean;
  createdAt: string;
  items: SimpleItem[];
}
export interface SimplePreferences {
  draft: string;
  concurrency: 1 | 2;
  selectedIds: string[];
  batch: SimpleBatch | null;
}

export function emptySimplePreferences(): SimplePreferences { return { draft: "", concurrency: 2, selectedIds: [], batch: null }; }

export function makeSimpleBatch(document: CanvasProjectDocument, selectedIds: readonly string[], prompt: string, concurrency: 1 | 2): SimpleBatch {
  if (!prompt.trim() || prompt.length > 20_000) throw new Error("请填写 1—20000 字符的提示词");
  const nodes = document.canvas.nodes.filter((node) => node.type === "image" && selectedIds.includes(node.id));
  if (!nodes.length || nodes.length > 200) throw new Error("请选择 1—200 张图片");
  return {
    id: `simple_${crypto.randomUUID()}`, prompt, concurrency, paused: false, createdAt: new Date().toISOString(),
    items: nodes.map((node) => ({ id: `item_${crypto.randomUUID()}`, sourceVersionId: String(node.payload.imageVersionId), sourceName: String(node.payload.name ?? "图片"), taskId: null, status: "queued", resultVersionIds: [], error: "" }))
  };
}

export function simpleTaskInput(document: CanvasProjectDocument, batch: SimpleBatch, item: SimpleItem, workbenchId: string): CreateTaskInput {
  const version = document.versions.find((entry) => entry.id === item.sourceVersionId);
  const asset = document.assets.find((entry) => entry.id === version?.assetId);
  if (!asset) throw new Error("底图资产不存在");
  return {
    taskType: "edit", responseMode: "image", prompt: batch.prompt,
    target: { provider: "chatgpt", chatMode: "new", localProject: { id: workbenchId as `project_${string}`, name: document.title } },
    attachments: [{ role: "structure-base", name: asset.originalName, relativePath: asset.original.relativePath }],
    simpleRender: { batchId: batch.id, itemId: item.id, sourceVersionId: item.sourceVersionId, concurrency: batch.concurrency }
  };
}

export function nextSimpleItem(batch: SimpleBatch, tasks: readonly GenerationTask[]): SimpleItem | null {
  if (batch.paused) return null;
  const known = tasks.filter((task) => task.simpleRender?.batchId === batch.id);
  const active = known.filter((task) => !["completed", "failed", "cancelled"].includes(task.status));
  if (active.length >= batch.concurrency || active.some((task) => !task.submittedAt || task.status === "needs-user")) return null;
  if (batch.items.some((item) => item.status === "failed")) return null;
  return batch.items.find((item) => item.status === "queued" && !known.some((task) => task.simpleRender?.itemId === item.id)) ?? null;
}

export function appendImage(document: CanvasProjectDocument, asset: CanvasImageAsset, name: string,
  options: { versionId?: `version_${string}`; taskId?: `task_${string}`; parentVersionId?: `version_${string}`; width?: number; height?: number } = {}): CanvasProjectDocument {
  const versionId = options.versionId ?? `version_${crypto.randomUUID()}`;
  if (document.versions.some((version) => version.id === versionId)) return document;
  const next = structuredClone(document);
  const parent = next.canvas.nodes.find((node) => node.payload.imageVersionId === options.parentVersionId);
  const size = fitImportedImage(options.width ?? asset.original.width, options.height ?? asset.original.height);
  const occupied = next.canvas.nodes.filter((node) => node.type === "image");
  const bounds = parent ? nextChildBoundsToRight(parent, size, occupied, 96, 48)
    : { x: 80, y: occupied.length ? Math.max(...occupied.map((node) => node.y + node.height)) + 72 : 80, ...size };
  if (!next.assets.some((entry) => entry.id === asset.id)) next.assets.push(asset);
  next.versions.push({ id: versionId, assetId: asset.id, origin: options.taskId ? "generated" : "imported", parentVersionId: options.parentVersionId ?? null, taskId: options.taskId ?? null, createdAt: new Date().toISOString() });
  next.canvas.nodes.push({ id: `node_${versionId.slice(8)}`, type: "image", ...bounds, rotation: 0, scaleX: 1, scaleY: 1, zIndex: next.canvas.nodes.length, visible: true, locked: false,
    payload: { imageVersionId: versionId, fit: "contain", name, sourceWidth: options.width ?? asset.original.width, sourceHeight: options.height ?? asset.original.height, outputRatio: "free" } });
  if (options.taskId) {
    let link = next.taskLinks.find((entry) => entry.taskId === options.taskId);
    if (!link) { link = { taskId: options.taskId, parentVersionId: options.parentVersionId ?? null, resultVersionIds: [], status: "completed" }; next.taskLinks.push(link); }
    if (!link.resultVersionIds.includes(versionId)) link.resultVersionIds.push(versionId);
  }
  return next;
}

export function batchFinished(batch: SimpleBatch | null): boolean {
  return !batch || batch.items.every((item) => ["completed", "cancelled"].includes(item.status));
}

export function simpleTaskLabel(task: GenerationTask | undefined, item: SimpleItem): string {
  if (item.status === "completed") return "已完成";
  if (item.status === "cancelled") return "已停止";
  if (item.status === "failed" || task?.status === "needs-user") return "需处理";
  if (task?.status === "completed" || task?.status === "collecting" || task?.status === "returning") return "正在收集";
  if (task?.submittedAt) return "渲染中";
  if (task) return "准备发送";
  return "排队中";
}

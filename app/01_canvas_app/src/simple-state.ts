import type { CanvasImageAsset, CreateTaskInput, GenerationTask, SimpleRenderConcurrency } from "@gpt-canvas/shared";
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
  variantOrdinal?: number;
  clonedFromItemId?: string;
  retryOfItemId?: string;
  supersededByItemId?: string;
}
export interface SimpleBatch {
  id: string;
  prompt: string;
  concurrency: SimpleRenderConcurrency;
  paused: boolean;
  createdAt: string;
  items: SimpleItem[];
}
export interface SimplePreferences {
  draft: string;
  concurrency: SimpleRenderConcurrency;
  copiesPerImage: 1 | 2 | 3;
  selectedIds: string[];
  batch: SimpleBatch | null;
}

export function emptySimplePreferences(): SimplePreferences { return { draft: "", concurrency: 2, copiesPerImage: 1, selectedIds: [], batch: null }; }

export function makeSimpleBatch(document: CanvasProjectDocument, selectedIds: readonly string[], prompt: string, concurrency: SimpleRenderConcurrency, copiesPerImage: number = 1): SimpleBatch {
  if (!prompt.trim() || prompt.length > 20_000) throw new Error("请填写 1—20000 字符的提示词");
  const copies = Math.min(3, Math.max(1, Math.round(copiesPerImage))) as 1 | 2 | 3;
  const nodes = document.canvas.nodes.filter((node) => node.type === "image" && selectedIds.includes(node.id));
  if (!nodes.length || nodes.length > 200) throw new Error("请选择 1—200 张图片");
  const total = nodes.length * copies;
  if (total > 200) throw new Error(`每张 ${copies} 个版本共 ${total} 个任务，超过 200 个任务上限`);
  const items: SimpleItem[] = [];
  for (let round = 1; round <= copies; round++) {
    for (const node of nodes) {
      items.push({ id: `item_${crypto.randomUUID()}`, sourceVersionId: String(node.payload.imageVersionId), sourceName: String(node.payload.name ?? "图片"), taskId: null, status: "queued", resultVersionIds: [], error: "", variantOrdinal: round });
    }
  }
  return { id: `simple_${crypto.randomUUID()}`, prompt, concurrency, paused: false, createdAt: new Date().toISOString(), items };
}

export function appendSimpleVariant(batch: SimpleBatch, sourceVersionId: string, count: number = 1): SimpleBatch {
  const source = batch.items.find((item) => item.sourceVersionId === sourceVersionId);
  if (!source) throw new Error("该底图不在当前批次中");
  if (batch.items.length + count > 200) throw new Error("批次任务上限为 200，无法继续追加");
  const next = structuredClone(batch);
  let ordinal = Math.max(0, ...next.items.filter((item) => item.sourceVersionId === sourceVersionId).map((item) => item.variantOrdinal ?? 0));
  for (let index = 0; index < count; index++) {
    ordinal += 1;
    next.items.push({ id: `item_${crypto.randomUUID()}`, sourceVersionId, sourceName: source.sourceName, taskId: null, status: "queued", resultVersionIds: [], error: "", variantOrdinal: ordinal, clonedFromItemId: source.id });
  }
  return next;
}

export function retrySimpleItem(batch: SimpleBatch, itemId: string): { batch: SimpleBatch; replacementId: string; wasCancelled: boolean } {
  const source = batch.items.find((item) => item.id === itemId);
  if (!source || (source.status !== "failed" && source.status !== "cancelled")) throw new Error("只有失败或已停止的任务可以重新生成");
  const next = structuredClone(batch);
  const ordinal = Math.max(0, ...next.items.filter((item) => item.sourceVersionId === source.sourceVersionId).map((item) => item.variantOrdinal ?? 0)) + 1;
  const replacementId = `item_${crypto.randomUUID()}`;
  const previous = next.items.find((item) => item.id === itemId)!;
  previous.supersededByItemId = replacementId;
  next.items.push({ id: replacementId, sourceVersionId: source.sourceVersionId, sourceName: source.sourceName, taskId: null, status: "queued", resultVersionIds: [], error: "", variantOrdinal: ordinal, retryOfItemId: itemId });
  return { batch: next, replacementId, wasCancelled: source.status === "cancelled" };
}

export function pendingSlots(items: readonly SimpleItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  const slots = new Map<string, number>();
  for (const item of items) {
    if (item.status === "completed" || item.status === "cancelled" || item.supersededByItemId) continue;
    const slot = counts.get(item.sourceVersionId) ?? 0;
    slots.set(item.id, slot);
    counts.set(item.sourceVersionId, slot + 1);
  }
  return slots;
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

export function simpleBlockingTask(batch: SimpleBatch, tasks: readonly GenerationTask[]): GenerationTask | null {
  return tasks.find((task) => !["completed", "failed", "cancelled"].includes(task.status)
    && (!task.simpleRender || task.simpleRender.batchId !== batch.id)) ?? null;
}

export function nextSimpleItem(batch: SimpleBatch, tasks: readonly GenerationTask[]): SimpleItem | null {
  if (batch.paused) return null;
  const known = tasks.filter((task) => task.simpleRender?.batchId === batch.id);
  const active = known.filter((task) => !["completed", "failed", "cancelled"].includes(task.status));
  if (active.length >= batch.concurrency || active.some((task) => !task.submittedAt || task.status === "needs-user")) return null;
  if (batch.items.some((item) => item.status === "failed" && !item.supersededByItemId)) return null;
  return batch.items.find((item) => item.status === "queued" && !known.some((task) => task.simpleRender?.itemId === item.id)) ?? null;
}

export function simpleSlotBounds(
  parent: { x: number; y: number; width: number; height: number },
  siblings: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
  slot: number,
  size: { width: number; height: number },
  gap = 48
): { x: number; y: number; width: number; height: number } {
  const base = siblings.length ? Math.max(...siblings.map((node) => node.y + node.height)) + gap : parent.y;
  return { x: Math.round(parent.x + parent.width + 96), y: Math.round(base + slot * (parent.height + gap)), ...size };
}

export function boundsOverlap(
  bounds: { x: number; y: number; width: number; height: number },
  nodes: ReadonlyArray<{ x: number; y: number; width: number; height: number }>
): boolean {
  return nodes.some((node) => bounds.x < node.x + node.width && bounds.x + bounds.width > node.x
    && bounds.y < node.y + node.height && bounds.y + bounds.height > node.y);
}

export function appendImage(document: CanvasProjectDocument, asset: CanvasImageAsset, name: string,
  options: { versionId?: `version_${string}`; taskId?: `task_${string}`; parentVersionId?: `version_${string}`; width?: number; height?: number; bounds?: { x: number; y: number; width: number; height: number } } = {}): CanvasProjectDocument {
  const versionId = options.versionId ?? `version_${crypto.randomUUID()}`;
  if (document.versions.some((version) => version.id === versionId)) return document;
  const next = structuredClone(document);
  const parent = next.canvas.nodes.find((node) => node.payload.imageVersionId === options.parentVersionId);
  const size = fitImportedImage(options.width ?? asset.original.width, options.height ?? asset.original.height);
  const occupied = next.canvas.nodes.filter((node) => node.type === "image");
  const requested = options.bounds ? { ...options.bounds, width: size.width, height: size.height } : null;
  const bounds = requested && !boundsOverlap(requested, occupied) ? requested
    : parent ? nextChildBoundsToRight(parent, size, occupied, 96, 48)
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
  return !batch || batch.items.every((item) => ["completed", "cancelled"].includes(item.status) || Boolean(item.supersededByItemId));
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

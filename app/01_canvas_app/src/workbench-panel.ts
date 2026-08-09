export const WORKBENCH_HEIGHT_STORAGE_KEY = "gpt-canvas.workbench-height";
export const WORKBENCH_WIDTH_STORAGE_KEY = "gpt-canvas.workbench-width";
export const WORKBENCH_MIN_HEIGHT = 224;
export const WORKBENCH_MAX_HEIGHT = 720;
export const WORKBENCH_MIN_WIDTH = 560;
export const WORKBENCH_MAX_WIDTH = 1376;

export type PromptApplyMode = "replace" | "append";

export type SelectionContextMode = "hidden" | "single" | "batch";

export interface SelectionContextPlacement {
  left: number;
  top: number;
  width: number;
  placement: "above" | "below" | "pinned";
}

export function selectionContextMode(imageCount: number, textCardCount = 0): SelectionContextMode {
  if (textCardCount > 0 || imageCount <= 0) return "hidden";
  return imageCount === 1 ? "single" : "batch";
}

export function selectionAfterTextCardHandoff(sourceId: string | null): {
  selectedId: string | null;
  selectedNodeIds: string[];
  selectedAnnotationId: null;
  selectedTextCardId: null;
  selectedTextCardIds: string[];
} {
  return {
    selectedId: sourceId,
    selectedNodeIds: sourceId ? [sourceId] : [],
    selectedAnnotationId: null,
    selectedTextCardId: null,
    selectedTextCardIds: []
  };
}

export function placeSelectionContextPanel(
  bounds: { x: number; y: number; width: number; height: number },
  viewport: { x: number; y: number; scale: number },
  canvas: { width: number; height: number },
  options: {
    minWidth?: number;
    maxWidth?: number;
    height?: number;
    gap?: number;
    padding?: number;
    leftInset?: number;
    rightInset?: number;
  } = {}
): SelectionContextPlacement | null {
  const minWidth = options.minWidth ?? 480;
  const maxWidth = options.maxWidth ?? 720;
  const panelHeight = options.height ?? 304;
  const gap = options.gap ?? 14;
  const padding = options.padding ?? 12;
  const leftInset = Math.max(padding, options.leftInset ?? 76);
  const rightInset = Math.max(padding, options.rightInset ?? 84);
  const nodeLeft = viewport.x + bounds.x * viewport.scale;
  const nodeTop = viewport.y + bounds.y * viewport.scale;
  const nodeWidth = bounds.width * viewport.scale;
  const nodeHeight = bounds.height * viewport.scale;
  const nodeRight = nodeLeft + nodeWidth;
  const nodeBottom = nodeTop + nodeHeight;

  if (
    canvas.width <= leftInset + rightInset
    || canvas.height <= panelHeight + padding * 2
    || nodeRight <= 0
    || nodeBottom <= 0
    || nodeLeft >= canvas.width
    || nodeTop >= canvas.height
  ) return null;

  const availableWidth = canvas.width - leftInset - rightInset;
  const width = Math.min(
    availableWidth,
    Math.max(Math.min(minWidth, availableWidth), Math.min(maxWidth, nodeWidth))
  );
  const preferredLeft = nodeLeft + (nodeWidth - width) / 2;
  const left = Math.round(Math.max(leftInset, Math.min(preferredLeft, canvas.width - rightInset - width)));
  const belowTop = nodeBottom + gap;
  if (belowTop + panelHeight <= canvas.height - padding) {
    return { left, top: Math.round(belowTop), width: Math.round(width), placement: "below" };
  }
  const aboveTop = nodeTop - gap - panelHeight;
  if (aboveTop >= padding) {
    return { left, top: Math.round(aboveTop), width: Math.round(width), placement: "above" };
  }
  return {
    left,
    top: Math.round(Math.max(padding, canvas.height - padding - panelHeight)),
    width: Math.round(width),
    placement: "pinned"
  };
}

export function batchWorkbenchStatus(input: {
  selectedCount: number;
  preparedCount: number;
  total: number;
  completed: number;
  failed: number;
}): string {
  if (input.total > 0) {
    const processed = Math.min(input.total, input.completed + input.failed);
    return processed >= input.total ? `${input.total}张已处理` : `${processed}/${input.total}已处理`;
  }
  const pending = input.selectedCount || input.preparedCount;
  return pending > 0 ? `${pending}张待发送` : "未选择";
}

export function promptWorkbenchStatus(count: number): string {
  return `${Math.max(0, count)}条`;
}

export function previewWorkbenchStatus(ready: boolean, missingCount: number): string {
  return ready ? "已就绪" : `${Math.max(0, missingCount)}项待补`;
}

export function deliveryWorkbenchStatus(selectionCount: number, configured: boolean): string {
  if (selectionCount > 0) return configured ? `${selectionCount}张可导出` : "待设目录";
  return configured ? "0张待导出" : "未就绪";
}

export function combinePromptText(current: string, incoming: string, mode: PromptApplyMode): string {
  const next = incoming.trim();
  if (mode === "replace") return next;
  return [current.trim(), next].filter(Boolean).join("\n\n");
}

export function appendUnifiedTaskRequirement(stagePrompt: string, requirement: string): string {
  const base = stagePrompt.trim();
  const addition = requirement.trim();
  if (!addition) return base;
  return `${base}\n\n【统一任务要求】\n${addition}`.trim();
}

export function clampWorkbenchHeight(value: number, viewportHeight: number): number {
  const viewportMaximum = Math.max(WORKBENCH_MIN_HEIGHT, viewportHeight - 48);
  const maximum = Math.min(WORKBENCH_MAX_HEIGHT, viewportMaximum);
  return Math.round(Math.min(maximum, Math.max(WORKBENCH_MIN_HEIGHT, value)));
}

export function resizedWorkbenchHeight(
  startHeight: number,
  startPointerY: number,
  currentPointerY: number,
  viewportHeight: number
): number {
  return clampWorkbenchHeight(startHeight + startPointerY - currentPointerY, viewportHeight);
}

export function storedWorkbenchHeight(rawValue: string | null, viewportHeight: number): number | null {
  if (!rawValue?.trim()) return null;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return null;
  return clampWorkbenchHeight(parsed, viewportHeight);
}

export function clampWorkbenchWidth(value: number, viewportWidth: number): number {
  const safeViewportWidth = Math.max(280, viewportWidth - (viewportWidth <= 704 ? 24 : 160));
  const minimum = Math.min(WORKBENCH_MIN_WIDTH, safeViewportWidth);
  const maximum = Math.max(minimum, Math.min(WORKBENCH_MAX_WIDTH, safeViewportWidth));
  return Math.round(Math.min(maximum, Math.max(minimum, value)));
}

export function resizedWorkbenchWidth(
  startWidth: number,
  startPointerX: number,
  currentPointerX: number,
  side: "left" | "right",
  viewportWidth: number
): number {
  const pointerDelta = side === "left"
    ? startPointerX - currentPointerX
    : currentPointerX - startPointerX;
  return clampWorkbenchWidth(startWidth + pointerDelta * 2, viewportWidth);
}

export function storedWorkbenchWidth(rawValue: string | null, viewportWidth: number): number | null {
  if (!rawValue?.trim()) return null;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return null;
  return clampWorkbenchWidth(parsed, viewportWidth);
}

import type { ImageNodeState } from "./canvas-layout.js";

export function shouldStartMarqueeOnBackground(tool: string): boolean {
  return tool === "select" || tool === "marquee";
}

export interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasSelectableBounds {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MixedCanvasSelection {
  imageIds: string[];
  textCardIds: string[];
}

export function normalizeSelectionRect(startX: number, startY: number, endX: number, endY: number): SelectionRect {
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY)
  };
}

export function selectObjectsInRect<T extends CanvasSelectableBounds>(objects: readonly T[], rect: SelectionRect): T[] {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return objects.filter((object) => (
    object.x < right
    && object.x + object.width > rect.x
    && object.y < bottom
    && object.y + object.height > rect.y
  ));
}

export function selectNodesInRect(nodes: readonly ImageNodeState[], rect: SelectionRect): ImageNodeState[] {
  return selectObjectsInRect(nodes, rect);
}

export function selectMixedCanvasObjectsInRect(
  images: readonly CanvasSelectableBounds[],
  textCards: readonly CanvasSelectableBounds[],
  rect: SelectionRect
): MixedCanvasSelection {
  return {
    imageIds: selectObjectsInRect(images, rect).map((image) => image.id),
    textCardIds: selectObjectsInRect(textCards, rect).map((card) => card.id)
  };
}

export function translateSelectedObjects<T extends CanvasSelectableBounds>(
  objects: readonly T[],
  selectedIds: ReadonlySet<string>,
  deltaX: number,
  deltaY: number
): T[] {
  if (!deltaX && !deltaY) return [...objects];
  return objects.map((object) => selectedIds.has(object.id)
    ? { ...object, x: Math.round(object.x + deltaX), y: Math.round(object.y + deltaY) }
    : object
  );
}

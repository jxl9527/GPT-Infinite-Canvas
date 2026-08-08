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

export function normalizeSelectionRect(startX: number, startY: number, endX: number, endY: number): SelectionRect {
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY)
  };
}

export function selectNodesInRect(nodes: readonly ImageNodeState[], rect: SelectionRect): ImageNodeState[] {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return nodes.filter((node) => (
    node.x < right
    && node.x + node.width > rect.x
    && node.y < bottom
    && node.y + node.height > rect.y
  ));
}

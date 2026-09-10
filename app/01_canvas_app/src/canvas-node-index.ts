import type { ImageNodeState } from "./canvas-layout.js";

export interface CanvasNodeIndex {
  byId: ReadonlyMap<string, ImageNodeState>;
  byVersionId: ReadonlyMap<string, ImageNodeState>;
  childrenByParentVersionId: ReadonlyMap<string, readonly ImageNodeState[]>;
}

export function buildCanvasNodeIndex(nodes: readonly ImageNodeState[]): CanvasNodeIndex {
  const byId = new Map<string, ImageNodeState>();
  const byVersionId = new Map<string, ImageNodeState>();
  const childrenByParentVersionId = new Map<string, ImageNodeState[]>();

  for (const node of nodes) {
    byId.set(node.id, node);
    byVersionId.set(node.versionId, node);
    if (!node.parentVersionId) continue;
    const siblings = childrenByParentVersionId.get(node.parentVersionId);
    if (siblings) siblings.push(node);
    else childrenByParentVersionId.set(node.parentVersionId, [node]);
  }

  return { byId, byVersionId, childrenByParentVersionId };
}

export function selectedNodesInCanvasOrder(
  nodes: readonly ImageNodeState[],
  selectedNodeIds: readonly string[]
): ImageNodeState[] {
  if (!selectedNodeIds.length) return [];
  const selected = new Set(selectedNodeIds);
  return nodes.filter((node) => selected.has(node.id));
}

import type { ImageNodeState } from "./canvas-layout.js";
import type { CanvasTextCard } from "./text-card.js";

interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LayoutReservation {
  sourceVersionId: ImageNodeState["versionId"];
  width: number;
  height: number;
}

export interface AutoArrangeCanvasOptions {
  nodeIds?: readonly string[];
  textCardIds?: readonly string[];
  start?: { x: number; y: number };
  columnGap?: number;
  siblingGap?: number;
  groupGap?: number;
  collisionGap?: number;
  reservations?: readonly LayoutReservation[];
}

export interface AutoArrangeCanvasResult {
  nodes: ImageNodeState[];
  textCards: CanvasTextCard[];
  bounds: LayoutRect;
  arrangedNodeIds: ImageNodeState["id"][];
  arrangedTextCardIds: CanvasTextCard["id"][];
}

interface LayoutGroup {
  nodes: ImageNodeState[];
  textCards: CanvasTextCard[];
  depthByNodeId: Map<ImageNodeState["id"], number>;
  sortX: number;
  sortY: number;
}

interface RelativePlacement extends LayoutRect {
  id: string;
  kind: "node" | "text-card" | "reservation";
}

const byCanvasPosition = <T extends { x: number; y: number }>(left: T, right: T): number => (
  left.y - right.y || left.x - right.x
);

function overlapsWithGap(left: LayoutRect, right: LayoutRect, gap: number): boolean {
  return left.x < right.x + right.width + gap
    && left.x + left.width + gap > right.x
    && left.y < right.y + right.height + gap
    && left.y + left.height + gap > right.y;
}

function boundsOf(rectangles: readonly LayoutRect[]): LayoutRect {
  if (!rectangles.length) return { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.min(...rectangles.map((rectangle) => rectangle.x));
  const y = Math.min(...rectangles.map((rectangle) => rectangle.y));
  const right = Math.max(...rectangles.map((rectangle) => rectangle.x + rectangle.width));
  const bottom = Math.max(...rectangles.map((rectangle) => rectangle.y + rectangle.height));
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y)
  };
}

function groupSortBounds(group: Pick<LayoutGroup, "nodes" | "textCards">): { x: number; y: number } {
  const objects = [...group.nodes, ...group.textCards];
  return {
    x: Math.min(...objects.map((object) => object.x)),
    y: Math.min(...objects.map((object) => object.y))
  };
}

function buildLayoutGroups(nodes: readonly ImageNodeState[], textCards: readonly CanvasTextCard[]): LayoutGroup[] {
  const nodeByVersionId = new Map(nodes.map((node) => [node.versionId, node]));
  const orderByNodeId = new Map(nodes.map((node, index) => [node.id, index]));
  const childrenByParentVersionId = new Map<ImageNodeState["versionId"], ImageNodeState[]>();
  for (const node of nodes) {
    if (!node.parentVersionId || !nodeByVersionId.has(node.parentVersionId)) continue;
    const children = childrenByParentVersionId.get(node.parentVersionId) ?? [];
    children.push(node);
    childrenByParentVersionId.set(node.parentVersionId, children);
  }
  for (const children of childrenByParentVersionId.values()) {
    children.sort((left, right) => byCanvasPosition(left, right)
      || (orderByNodeId.get(left.id) ?? 0) - (orderByNodeId.get(right.id) ?? 0));
  }

  const roots = nodes
    .filter((node) => !node.parentVersionId || !nodeByVersionId.has(node.parentVersionId))
    .sort((left, right) => byCanvasPosition(left, right)
      || (orderByNodeId.get(left.id) ?? 0) - (orderByNodeId.get(right.id) ?? 0));
  const assignedNodeIds = new Set<ImageNodeState["id"]>();
  const groups: LayoutGroup[] = [];

  const addTree = (root: ImageNodeState) => {
    if (assignedNodeIds.has(root.id)) return;
    const groupNodes: ImageNodeState[] = [];
    const depthByNodeId = new Map<ImageNodeState["id"], number>();
    const queue: Array<{ node: ImageNodeState; depth: number }> = [{ node: root, depth: 0 }];
    let queueIndex = 0;
    while (queueIndex < queue.length) {
      const current = queue[queueIndex];
      queueIndex += 1;
      if (assignedNodeIds.has(current.node.id)) continue;
      assignedNodeIds.add(current.node.id);
      groupNodes.push(current.node);
      depthByNodeId.set(current.node.id, current.depth);
      for (const child of childrenByParentVersionId.get(current.node.versionId) ?? []) {
        queue.push({ node: child, depth: current.depth + 1 });
      }
    }
    const sort = groupSortBounds({ nodes: groupNodes, textCards: [] });
    groups.push({ nodes: groupNodes, textCards: [], depthByNodeId, sortX: sort.x, sortY: sort.y });
  };

  roots.forEach(addTree);
  nodes
    .filter((node) => !assignedNodeIds.has(node.id))
    .sort((left, right) => byCanvasPosition(left, right))
    .forEach(addTree);

  const groupByVersionId = new Map<ImageNodeState["versionId"], LayoutGroup>();
  for (const group of groups) {
    for (const node of group.nodes) groupByVersionId.set(node.versionId, group);
  }
  const orphanGroupBySource = new Map<string, LayoutGroup>();
  for (const textCard of [...textCards].sort(byCanvasPosition)) {
    const linked = textCard.sourceVersionId ? groupByVersionId.get(textCard.sourceVersionId) : undefined;
    if (linked) {
      linked.textCards.push(textCard);
      continue;
    }
    const orphanKey = textCard.sourceVersionId ?? textCard.id;
    let orphan = orphanGroupBySource.get(orphanKey);
    if (!orphan) {
      orphan = {
        nodes: [],
        textCards: [],
        depthByNodeId: new Map(),
        sortX: textCard.x,
        sortY: textCard.y
      };
      orphanGroupBySource.set(orphanKey, orphan);
      groups.push(orphan);
    }
    orphan.textCards.push(textCard);
  }

  for (const group of groups) {
    group.nodes.sort((left, right) => {
      const depth = (group.depthByNodeId.get(left.id) ?? 0) - (group.depthByNodeId.get(right.id) ?? 0);
      return depth || byCanvasPosition(left, right) || (orderByNodeId.get(left.id) ?? 0) - (orderByNodeId.get(right.id) ?? 0);
    });
    group.textCards.sort((left, right) => byCanvasPosition(left, right)
      || left.createdAt.localeCompare(right.createdAt));
    const sort = groupSortBounds(group);
    group.sortX = sort.x;
    group.sortY = sort.y;
  }
  return groups.sort((left, right) => left.sortY - right.sortY || left.sortX - right.sortX);
}

export function autoArrangeCanvasObjects(
  nodes: readonly ImageNodeState[],
  textCards: readonly CanvasTextCard[],
  options: AutoArrangeCanvasOptions = {}
): AutoArrangeCanvasResult {
  const hasExplicitScope = options.nodeIds !== undefined || options.textCardIds !== undefined;
  const requestedNodeIds = new Set(options.nodeIds ?? []);
  const requestedTextCardIds = new Set(options.textCardIds ?? []);
  const scopedNodes = nodes.filter((node) => !hasExplicitScope || requestedNodeIds.has(node.id));
  const scopedTextCards = textCards.filter((card) => !hasExplicitScope || requestedTextCardIds.has(card.id));
  const scopedNodeIds = new Set(scopedNodes.map((node) => node.id));
  const scopedTextCardIds = new Set(scopedTextCards.map((card) => card.id));
  const scopedNodeById = new Map(scopedNodes.map((node) => [node.id, node]));
  const scopedTextCardById = new Map(scopedTextCards.map((card) => [card.id, card]));
  const fixedObstacles: LayoutRect[] = [
    ...nodes.filter((node) => !scopedNodeIds.has(node.id)),
    ...textCards.filter((card) => !scopedTextCardIds.has(card.id))
  ];
  const scopedObjects = [...scopedNodes, ...scopedTextCards];
  if (!scopedObjects.length) {
    return {
      nodes: [...nodes],
      textCards: [...textCards],
      bounds: boundsOf([...nodes, ...textCards]),
      arrangedNodeIds: [],
      arrangedTextCardIds: []
    };
  }

  const columnGap = Math.max(0, options.columnGap ?? 120);
  const siblingGap = Math.max(0, options.siblingGap ?? 64);
  const groupGap = Math.max(0, options.groupGap ?? 160);
  const collisionGap = Math.max(0, options.collisionGap ?? 24);
  const currentBounds = boundsOf(scopedObjects);
  const start = options.start ?? { x: currentBounds.x, y: currentBounds.y };
  const groups = buildLayoutGroups(scopedNodes, scopedTextCards);
  const maximumCardWidth = scopedTextCards.length
    ? Math.max(...scopedTextCards.map((card) => card.width))
    : 0;
  const maximumNodeWidthByDepth = new Map<number, number>();
  const depthByVersionId = new Map<ImageNodeState["versionId"], number>();
  const groupByVersionId = new Map<ImageNodeState["versionId"], LayoutGroup>();
  for (const group of groups) {
    for (const node of group.nodes) {
      const depth = group.depthByNodeId.get(node.id) ?? 0;
      maximumNodeWidthByDepth.set(depth, Math.max(maximumNodeWidthByDepth.get(depth) ?? 0, node.width));
      depthByVersionId.set(node.versionId, depth);
      groupByVersionId.set(node.versionId, group);
    }
  }
  const depthX = new Map<number, number>();
  const rootX = start.x + (maximumCardWidth ? maximumCardWidth + columnGap : 0);
  const maximumDepth = Math.max(0, ...maximumNodeWidthByDepth.keys());
  let xCursor = rootX;
  for (let depth = 0; depth <= maximumDepth + 1; depth += 1) {
    depthX.set(depth, xCursor);
    xCursor += (maximumNodeWidthByDepth.get(depth) ?? 0) + columnGap;
  }

  const reservationsByGroup = new Map<LayoutGroup, Array<LayoutReservation & { depth: number }>>();
  for (const reservation of options.reservations ?? []) {
    const group = groupByVersionId.get(reservation.sourceVersionId);
    const sourceDepth = depthByVersionId.get(reservation.sourceVersionId);
    if (!group || sourceDepth === undefined) continue;
    const reservations = reservationsByGroup.get(group) ?? [];
    reservations.push({
      ...reservation,
      width: Math.max(1, reservation.width),
      height: Math.max(1, reservation.height),
      depth: sourceDepth + 1
    });
    reservationsByGroup.set(group, reservations);
  }

  const arrangedNodes = new Map<ImageNodeState["id"], ImageNodeState>();
  const arrangedTextCards = new Map<CanvasTextCard["id"], CanvasTextCard>();
  const placedRectangles: LayoutRect[] = [];
  let groupY = start.y;

  for (const group of groups) {
    const relativePlacements: RelativePlacement[] = [];
    let cardY = 0;
    for (const textCard of group.textCards) {
      relativePlacements.push({
        id: textCard.id,
        kind: "text-card",
        x: start.x,
        y: cardY,
        width: textCard.width,
        height: textCard.height
      });
      cardY += textCard.height + siblingGap;
    }

    const nodesByDepth = new Map<number, ImageNodeState[]>();
    for (const node of group.nodes) {
      const depth = group.depthByNodeId.get(node.id) ?? 0;
      const laneNodes = nodesByDepth.get(depth) ?? [];
      laneNodes.push(node);
      nodesByDepth.set(depth, laneNodes);
    }
    const reservationsByDepth = new Map<number, Array<LayoutReservation & { depth: number }>>();
    for (const reservation of reservationsByGroup.get(group) ?? []) {
      const laneReservations = reservationsByDepth.get(reservation.depth) ?? [];
      laneReservations.push(reservation);
      reservationsByDepth.set(reservation.depth, laneReservations);
    }
    const laneDepths = [...new Set([...nodesByDepth.keys(), ...reservationsByDepth.keys()])]
      .sort((left, right) => left - right);
    for (const depth of laneDepths) {
      let laneY = 0;
      for (const node of nodesByDepth.get(depth) ?? []) {
        relativePlacements.push({
          id: node.id,
          kind: "node",
          x: depthX.get(depth) ?? rootX,
          y: laneY,
          width: node.width,
          height: node.height
        });
        laneY += node.height + siblingGap;
      }
      for (const reservation of reservationsByDepth.get(depth) ?? []) {
        relativePlacements.push({
          id: `reservation_${reservation.sourceVersionId}_${laneY}`,
          kind: "reservation",
          x: depthX.get(depth) ?? rootX,
          y: laneY,
          width: reservation.width,
          height: reservation.height
        });
        laneY += reservation.height + siblingGap;
      }
    }

    const groupHeight = Math.max(1, ...relativePlacements.map((placement) => placement.y + placement.height));
    let attempts = 0;
    while (attempts < fixedObstacles.length + 1) {
      let shiftedY = groupY;
      for (const placement of relativePlacements) {
        const candidate = { ...placement, y: groupY + placement.y };
        for (const obstacle of fixedObstacles) {
          if (!overlapsWithGap(candidate, obstacle, collisionGap)) continue;
          shiftedY = Math.max(shiftedY, obstacle.y + obstacle.height + collisionGap - placement.y);
        }
      }
      if (shiftedY === groupY) break;
      groupY = shiftedY;
      attempts += 1;
    }

    for (const placement of relativePlacements) {
      const placed = { ...placement, y: groupY + placement.y };
      placedRectangles.push(placed);
      if (placement.kind === "node") {
        const node = scopedNodeById.get(placement.id as ImageNodeState["id"]);
        if (node) arrangedNodes.set(node.id, { ...node, x: placed.x, y: placed.y });
      } else if (placement.kind === "text-card") {
        const textCard = scopedTextCardById.get(placement.id as CanvasTextCard["id"]);
        if (textCard) arrangedTextCards.set(textCard.id, { ...textCard, x: placed.x, y: placed.y });
      }
    }
    groupY += groupHeight + groupGap;
  }

  return {
    nodes: nodes.map((node) => arrangedNodes.get(node.id) ?? node),
    textCards: textCards.map((card) => arrangedTextCards.get(card.id) ?? card),
    bounds: boundsOf(placedRectangles),
    arrangedNodeIds: scopedNodes.map((node) => node.id),
    arrangedTextCardIds: scopedTextCards.map((card) => card.id)
  };
}

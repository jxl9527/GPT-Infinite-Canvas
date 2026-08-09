export const OUTPUT_RATIOS = ["free", "1:1", "4:3", "3:2", "16:9"] as const;
export type OutputRatio = (typeof OUTPUT_RATIOS)[number];

export interface ImageNodeState {
  id: `node_${string}`;
  assetId: `asset_${string}`;
  originalRelativePath: string;
  versionId: `version_${string}`;
  origin: "imported" | "generated" | "annotated";
  parentVersionId: `version_${string}` | null;
  taskId: `task_${string}` | null;
  name: string;
  src: string;
  sourceWidth: number;
  sourceHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
  outputRatio: OutputRatio;
}

export interface CanvasRelation {
  axis: "horizontal" | "vertical";
  points: [number, number, number, number, number, number, number, number];
}

export interface ImageContextToolbarPlacement {
  left: number;
  top: number;
  width: number;
  placement: "above" | "below";
}

export function placeImageContextToolbar(
  node: Pick<ImageNodeState, "x" | "y" | "width" | "height">,
  viewport: { x: number; y: number; scale: number },
  canvas: { width: number; height: number },
  options: {
    minWidth?: number;
    maxWidth?: number;
    height?: number;
    gap?: number;
    padding?: number;
    leftInset?: number;
  } = {}
): ImageContextToolbarPlacement | null {
  const minWidth = options.minWidth ?? 330;
  const maxWidth = options.maxWidth ?? 460;
  const toolbarHeight = options.height ?? 54;
  const gap = options.gap ?? 10;
  const padding = options.padding ?? 12;
  const leftInset = Math.max(padding, options.leftInset ?? padding);
  const nodeLeft = viewport.x + node.x * viewport.scale;
  const nodeTop = viewport.y + node.y * viewport.scale;
  const nodeWidth = node.width * viewport.scale;
  const nodeHeight = node.height * viewport.scale;
  const nodeRight = nodeLeft + nodeWidth;
  const nodeBottom = nodeTop + nodeHeight;

  if (
    canvas.width <= leftInset + padding
    || canvas.height <= toolbarHeight + padding * 2
    || nodeRight <= 0
    || nodeBottom <= 0
    || nodeLeft >= canvas.width
    || nodeTop >= canvas.height
  ) {
    return null;
  }

  const availableWidth = canvas.width - leftInset - padding;
  const width = Math.min(
    availableWidth,
    Math.max(Math.min(minWidth, availableWidth), Math.min(maxWidth, nodeWidth))
  );
  const preferredLeft = nodeLeft + (nodeWidth - width) / 2;
  const left = Math.max(leftInset, Math.min(preferredLeft, canvas.width - width - padding));
  const aboveTop = nodeTop - gap - toolbarHeight;
  if (aboveTop >= padding) {
    return { left, top: aboveTop, width, placement: "above" };
  }

  const belowTop = nodeBottom + gap;
  return {
    left,
    top: Math.max(padding, Math.min(belowTop, canvas.height - toolbarHeight - padding)),
    width,
    placement: "below"
  };
}

export function buildCanvasRelation(
  parent: Pick<ImageNodeState, "x" | "y" | "width" | "height">,
  child: Pick<ImageNodeState, "x" | "y" | "width" | "height">,
  gap = 8
): CanvasRelation {
  const parentCenter = {
    x: parent.x + parent.width / 2,
    y: parent.y + parent.height / 2
  };
  const childCenter = {
    x: child.x + child.width / 2,
    y: child.y + child.height / 2
  };
  const deltaX = childCenter.x - parentCenter.x;
  const deltaY = childCenter.y - parentCenter.y;

  if (Math.abs(deltaX) >= Math.abs(deltaY)) {
    const direction = deltaX >= 0 ? 1 : -1;
    const startX = parentCenter.x + direction * (parent.width / 2 + gap);
    const endX = childCenter.x - direction * (child.width / 2 + gap);
    const distance = Math.max(1, Math.abs(endX - startX));
    const control = Math.max(54, distance * 0.42);
    return {
      axis: "horizontal",
      points: [
        startX,
        parentCenter.y,
        startX + direction * control,
        parentCenter.y,
        endX - direction * control,
        childCenter.y,
        endX,
        childCenter.y
      ]
    };
  }

  const direction = deltaY >= 0 ? 1 : -1;
  const startY = parentCenter.y + direction * (parent.height / 2 + gap);
  const endY = childCenter.y - direction * (child.height / 2 + gap);
  const distance = Math.max(1, Math.abs(endY - startY));
  const control = Math.max(54, distance * 0.42);
  return {
    axis: "vertical",
    points: [
      parentCenter.x,
      startY,
      parentCenter.x,
      startY + direction * control,
      childCenter.x,
      endY - direction * control,
      childCenter.x,
      endY
    ]
  };
}

const RATIO_VALUES: Readonly<Record<Exclude<OutputRatio, "free">, number>> = {
  "1:1": 1,
  "4:3": 4 / 3,
  "3:2": 3 / 2,
  "16:9": 16 / 9
};

export function fitImportedImage(
  width: number,
  height: number,
  maximumWidth = 640,
  maximumHeight = 440
): { width: number; height: number } {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const scale = Math.min(1, maximumWidth / safeWidth, maximumHeight / safeHeight);
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale))
  };
}

export function applyOutputRatio(node: ImageNodeState, ratio: OutputRatio): ImageNodeState {
  const targetRatio = ratio === "free" ? node.sourceWidth / node.sourceHeight : RATIO_VALUES[ratio];
  return {
    ...node,
    outputRatio: ratio,
    height: Math.max(80, Math.round(node.width / targetRatio))
  };
}

export function arrangeHorizontally(
  nodes: readonly ImageNodeState[],
  start = { x: 120, y: 120 },
  gap = 96
): ImageNodeState[] {
  let cursor = start.x;
  return nodes.map((node) => {
    const next = { ...node, x: cursor, y: start.y };
    cursor += node.width + gap;
    return next;
  });
}

export function arrangeVertically(
  nodes: readonly ImageNodeState[],
  start = { x: 120, y: 120 },
  gap = 96
): ImageNodeState[] {
  let cursor = start.y;
  return nodes.map((node) => {
    const next = { ...node, x: start.x, y: cursor };
    cursor += node.height + gap;
    return next;
  });
}

export function normalizeImageFrames(
  nodes: readonly ImageNodeState[],
  referenceId?: string | null
): ImageNodeState[] {
  const reference = nodes.find((node) => node.id === referenceId) ?? nodes[0];
  if (!reference) return [];
  const height = Math.max(80, Math.round(reference.height));
  return nodes.map((node) => {
    const sourceWidth = Math.max(1, node.sourceWidth);
    const sourceHeight = Math.max(1, node.sourceHeight);
    return {
      ...node,
      width: Math.max(1, height * sourceWidth / sourceHeight),
      height,
      outputRatio: "free"
    };
  });
}

export function removeImageNode(
  nodes: readonly ImageNodeState[],
  nodeId: string
): ImageNodeState[] {
  const removed = nodes.find((node) => node.id === nodeId);
  if (!removed) return [...nodes];
  return nodes
    .filter((node) => node.id !== nodeId)
    .map((node) => node.parentVersionId === removed.versionId
      ? { ...node, parentVersionId: null }
      : node
    );
}

export function placeChildToRight(
  parent: ImageNodeState,
  child: ImageNodeState,
  gap = 96
): ImageNodeState {
  return {
    ...child,
    x: Math.round(parent.x + parent.width + gap),
    y: Math.round(parent.y),
    parentVersionId: parent.versionId
  };
}

export function nextChildBoundsToRight(
  parent: Pick<ImageNodeState, "x" | "y" | "width" | "height">,
  child: Pick<ImageNodeState, "width" | "height">,
  occupied: readonly Pick<ImageNodeState, "x" | "y" | "width" | "height">[] = [],
  horizontalGap = 96,
  verticalGap = 48
): { x: number; y: number; width: number; height: number } {
  const x = Math.round(parent.x + parent.width + horizontalGap);
  const width = Math.max(1, Math.round(child.width));
  const height = Math.max(1, Math.round(child.height));
  let y = Math.round(parent.y);
  const horizontallyOverlapping = occupied
    .filter((item) => item.x < x + width && item.x + item.width > x)
    .sort((left, right) => left.y - right.y);

  for (const item of horizontallyOverlapping) {
    const overlapsVertically = y < item.y + item.height && y + height > item.y;
    if (overlapsVertically) y = Math.round(item.y + item.height + verticalGap);
  }
  return { x, y, width, height };
}

export function placeChildToRightStacked(
  parent: ImageNodeState,
  child: ImageNodeState,
  occupied: readonly Pick<ImageNodeState, "x" | "y" | "width" | "height">[] = [],
  horizontalGap = 96,
  verticalGap = 48
): ImageNodeState {
  const bounds = nextChildBoundsToRight(parent, child, occupied, horizontalGap, verticalGap);
  return {
    ...child,
    x: bounds.x,
    y: bounds.y,
    parentVersionId: parent.versionId
  };
}

export function coverCrop(
  source: { width: number; height: number },
  frame: { width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const sourceRatio = source.width / source.height;
  const frameRatio = frame.width / frame.height;
  if (Math.abs(sourceRatio - frameRatio) <= 1e-9) {
    return { x: 0, y: 0, width: source.width, height: source.height };
  }
  if (sourceRatio > frameRatio) {
    const width = source.height * frameRatio;
    return { x: (source.width - width) / 2, y: 0, width, height: source.height };
  }
  const height = source.width / frameRatio;
  return { x: 0, y: (source.height - height) / 2, width: source.width, height };
}

export function coverCropForRenderedImage(
  decoded: { width: number; height: number } | null,
  metadata: { width: number; height: number },
  frame: { width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const decodedIsUsable = Boolean(
    decoded
    && Number.isFinite(decoded.width)
    && Number.isFinite(decoded.height)
    && decoded.width > 0
    && decoded.height > 0
  );
  return coverCrop(decodedIsUsable ? decoded! : metadata, frame);
}

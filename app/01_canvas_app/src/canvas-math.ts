export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 4;

export interface Point {
  x: number;
  y: number;
}

export interface Viewport extends Point {
  scale: number;
}

export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

export function fixedScreenScale(viewportScale: number): number {
  return 1 / clampZoom(viewportScale);
}

export function zoomAtPoint(viewport: Viewport, pointer: Point, requestedScale: number): Viewport {
  const nextScale = clampZoom(requestedScale);
  const world = {
    x: (pointer.x - viewport.x) / viewport.scale,
    y: (pointer.y - viewport.y) / viewport.scale
  };
  return {
    scale: nextScale,
    x: pointer.x - world.x * nextScale,
    y: pointer.y - world.y * nextScale
  };
}

export function fitRect(
  viewportSize: { width: number; height: number },
  rect: { x: number; y: number; width: number; height: number },
  padding = 72
): Viewport {
  const usableWidth = Math.max(1, viewportSize.width - padding * 2);
  const usableHeight = Math.max(1, viewportSize.height - padding * 2);
  const scale = clampZoom(Math.min(usableWidth / rect.width, usableHeight / rect.height));
  return {
    scale,
    x: (viewportSize.width - rect.width * scale) / 2 - rect.x * scale,
    y: (viewportSize.height - rect.height * scale) / 2 - rect.y * scale
  };
}

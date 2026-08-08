export const WORKBENCH_HEIGHT_STORAGE_KEY = "gpt-canvas.workbench-height";
export const WORKBENCH_WIDTH_STORAGE_KEY = "gpt-canvas.workbench-width";
export const WORKBENCH_MIN_HEIGHT = 224;
export const WORKBENCH_MAX_HEIGHT = 720;
export const WORKBENCH_MIN_WIDTH = 560;
export const WORKBENCH_MAX_WIDTH = 1376;

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

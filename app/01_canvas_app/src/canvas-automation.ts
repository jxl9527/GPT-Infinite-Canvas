import { nextChildBoundsToRight } from "./canvas-layout.js";

export const MINIMUM_AUTOMATION_EXTENSION_VERSION = "1.5.22";

export function automationExtensionVersion(explicitVersion: string | null, message: string | null): string | null {
  const candidate = explicitVersion?.trim() || message?.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] || "";
  return /^\d+\.\d+\.\d+$/.test(candidate) ? candidate : null;
}

export function automationExtensionVersionSupported(
  version: string | null,
  minimum = MINIMUM_AUTOMATION_EXTENSION_VERSION
): boolean {
  if (!version) return false;
  const left = version.split(".").map(Number);
  const right = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return true;
}

export function automationExtensionReady(status: string | null, version: string | null): boolean {
  return (status === "ready" || status === "started") && automationExtensionVersionSupported(version);
}

export function shouldAutoReturnResults(
  status: string | undefined,
  resultCount: number,
  returnedCount: number,
  returning: boolean
): boolean {
  return status === "completed"
    && resultCount > 0
    && returnedCount < resultCount
    && !returning;
}

export function shouldShowImageGenerationPlaceholder(
  status: string | undefined,
  responseMode: "image" | "text" | "image-or-text" | undefined,
  resultCount: number,
  hasReturnedNode: boolean
): boolean {
  if (!status || responseMode !== "image" || hasReturnedNode) return false;
  if (status === "failed" || status === "cancelled") return false;
  return status !== "completed" || resultCount > 0;
}

export function generationPlaceholderBounds(
  source: { x: number; y: number; width: number; height: number },
  occupied: readonly { x: number; y: number; width: number; height: number }[] = [],
  gap = 96,
  verticalGap = 48
): { x: number; y: number; width: number; height: number } {
  return nextChildBoundsToRight(source, source, occupied, gap, verticalGap);
}

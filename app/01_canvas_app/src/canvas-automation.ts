export const MINIMUM_AUTOMATION_EXTENSION_VERSION = "1.5.16";

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

import { MAX_VIEWPOINT_NAME_LENGTH } from "@gpt-canvas/shared";

const D5_CHANNEL_SUFFIX = /_(AO|MaterialID|Transparent|SkyMask|Z-Depth|Reflection)$/i;

function truncateViewpointName(value: string): string {
  if (value.length <= MAX_VIEWPOINT_NAME_LENGTH) return value;
  const shortened = value
    .slice(0, MAX_VIEWPOINT_NAME_LENGTH - 1)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trimEnd();
  return `${shortened}…`;
}

export function viewpointNameFromFilename(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "").trim();
  const normalized = stem.replace(D5_CHANNEL_SUFFIX, "").trim() || "未命名视角";
  return truncateViewpointName(normalized);
}

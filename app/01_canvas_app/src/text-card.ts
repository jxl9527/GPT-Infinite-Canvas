export const TEXT_CARD_KINDS = ["review", "prompt"] as const;
export type CanvasTextCardKind = (typeof TEXT_CARD_KINDS)[number];

export interface CanvasTextCard {
  id: `text_card_${string}`;
  kind: CanvasTextCardKind;
  title: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  sourceVersionId: `version_${string}` | null;
  taskId: `task_${string}`;
  createdAt: string;
  updatedAt: string;
}

export const TEXT_CARD_MIN_WIDTH = 320;
export const TEXT_CARD_MIN_HEIGHT = 240;

export function resizedTextCardSize(
  width: number,
  height: number,
  deltaX: number,
  deltaY: number,
  scale = 1
): { width: number; height: number } {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    width: Math.max(TEXT_CARD_MIN_WIDTH, Math.round(width + deltaX / safeScale)),
    height: Math.max(TEXT_CARD_MIN_HEIGHT, Math.round(height + deltaY / safeScale))
  };
}

export function createCanvasTextCard(input: {
  kind: CanvasTextCardKind;
  title: string;
  text: string;
  sourceVersionId: `version_${string}` | null;
  taskId: `task_${string}`;
  sourceBounds?: { x: number; y: number; width: number; height: number } | null;
  siblingCount?: number;
  now?: string;
}): CanvasTextCard {
  const now = input.now ?? new Date().toISOString();
  const width = 460;
  const height = 360;
  const siblingOffset = Math.max(0, input.siblingCount ?? 0) * (height + 36);
  const source = input.sourceBounds;
  return {
    id: `text_card_${crypto.randomUUID()}`,
    kind: input.kind,
    title: input.title.trim().slice(0, 120) || (input.kind === "prompt" ? "生成提示词" : "GPT审查结论"),
    text: input.text.trim(),
    x: source ? source.x + source.width + 72 : 160,
    y: source ? source.y + siblingOffset : 140 + siblingOffset,
    width,
    height,
    sourceVersionId: input.sourceVersionId,
    taskId: input.taskId,
    createdAt: now,
    updatedAt: now
  };
}

export function extractFinalPrompt(text: string): string {
  const normalized = text.trim();
  if (!normalized) return "";
  const marker = /(?:^|\n)【最终(?:生成)?提示词】\s*\n?/;
  const match = marker.exec(normalized);
  if (!match || match.index === undefined) return normalized;
  const start = match.index + match[0].length;
  const remainder = normalized.slice(start);
  const nextSection = /\n【[^】]+】/.exec(remainder);
  return remainder.slice(0, nextSection?.index ?? remainder.length).trim() || normalized;
}

export function aspectRatiosMatch(
  sourceWidth: number,
  sourceHeight: number,
  resultWidth: number,
  resultHeight: number,
  tolerance = 0.005
): boolean {
  if ([sourceWidth, sourceHeight, resultWidth, resultHeight].some((value) => !Number.isFinite(value) || value <= 0)) {
    return false;
  }
  const sourceRatio = sourceWidth / sourceHeight;
  const resultRatio = resultWidth / resultHeight;
  return Math.abs(sourceRatio - resultRatio) / sourceRatio <= tolerance;
}

export function alignedGlassFilename(filename: string): string {
  const match = /^(.*?)(\.[^.]+)?$/.exec(filename.trim());
  const stem = match?.[1] || "玻璃整图";
  const extension = match?.[2] || ".png";
  return `${stem}_PS对齐${extension}`;
}

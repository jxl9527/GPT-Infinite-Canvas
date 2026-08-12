export const TEXT_CARD_KINDS = ["review", "prompt"] as const;
export type CanvasTextCardKind = (typeof TEXT_CARD_KINDS)[number];
export type CanvasTextCardHandoffState = "pending" | "loaded" | "used";

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
  workflowLabel?: string;
  handoffState?: CanvasTextCardHandoffState;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
}

export function textCardHandoffLabel(state: CanvasTextCardHandoffState | undefined): string {
  if (state === "loaded") return "已载入输入框";
  if (state === "used") return "已用于生成";
  return "待确认";
}

export function nextWorkflowActionForTextCard(kind: CanvasTextCardKind): "prompt" | "generate" {
  return kind === "prompt" ? "generate" : "prompt";
}

export function buildPromptOptimizerInput(text: string, optimizerTemplate: string): string {
  const prompt = extractFinalPrompt(text).trim();
  return optimizerTemplate.replace("[粘贴原始提示词]", prompt).trim();
}

export interface ReturnedTextSection {
  id: string;
  title: string;
  content: string;
}

export const TEXT_CARD_WORKFLOW_LABELS = {
  preflight: "阶段一 · 构图与 SU 审查",
  sceneReference: "优化阶段 · 参考风格生成提示词",
  sceneDirection: "优化阶段 · 文字方向生成提示词",
  promptOptimizer: "优化阶段 · 继续优化提示词",
  sceneGenerate: "优化阶段 · 按提示词生成 D5 目标图",
  finalGlass: "阶段三 · 最终玻璃深化"
} as const;

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
  workflowLabel?: string;
  idempotencyKey?: string;
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
    text: normalizeReturnedText(input.text),
    x: source ? source.x + source.width + 72 : 160,
    y: source ? source.y + siblingOffset : 140 + siblingOffset,
    width,
    height,
    sourceVersionId: input.sourceVersionId,
    taskId: input.taskId,
    ...(input.workflowLabel?.trim() ? { workflowLabel: input.workflowLabel.trim().slice(0, 120) } : {}),
    ...(input.idempotencyKey?.trim() ? { idempotencyKey: input.idempotencyKey.trim().slice(0, 500) } : {}),
    createdAt: now,
    updatedAt: now
  };
}

export function normalizeReturnedText(text: string): string {
  return text
    .trim()
    .replace(/^ChatGPT\s*(?:说)?\s*[：:]\s*/i, "")
    .trim();
}

export function textCardDisplayTitle(title: string): string {
  return title
    .replace(/\s*[｜|]\s*(?:生成提示词|审查结论)\s*$/, "")
    .trim() || title.trim();
}

export function returnedTextCharacterCount(text: string): number {
  return normalizeReturnedText(text).replace(/\s/g, "").length;
}

export function parseReturnedTextSections(text: string): ReturnedTextSection[] {
  const normalized = normalizeReturnedText(text);
  if (!normalized) return [];
  const matches = [...normalized.matchAll(/【([^】\r\n]{1,48})】/g)];
  if (!matches.length) return [{ id: "full-0", title: "完整内容", content: normalized }];
  const sections: ReturnedTextSection[] = [];
  const preamble = normalized.slice(0, matches[0]?.index ?? 0).trim();
  if (preamble) sections.push({ id: "intro-0", title: "说明", content: preamble });
  matches.forEach((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? normalized.length;
    const content = normalized.slice(start, end).trim();
    sections.push({ id: `section-${index}`, title: match[1]?.trim() || `第${index + 1}节`, content });
  });
  return sections;
}

export function inferTextCardWorkflowLabel(input: {
  workflowStage?: "preflight" | "scene-optimization" | "final-glass" | "completed" | null;
  action?: "analyze" | "prompt" | "generate" | null;
  hasStyleReference?: boolean;
  prompt?: string;
  kind?: CanvasTextCardKind;
}): string {
  const prompt = normalizeReturnedText(input.prompt ?? "");
  if (input.workflowStage === "final-glass" || /最终阶段[·｜：:]?整图玻璃深化/.test(prompt)) {
    return TEXT_CARD_WORKFLOW_LABELS.finalGlass;
  }
  if (
    input.workflowStage === "preflight"
    || input.kind === "review"
    || /阶段一|前置阶段|【视角结论】|【相机与构图调整】/.test(prompt)
  ) return TEXT_CARD_WORKFLOW_LABELS.preflight;
  if (/【不完整提示词优化】|【优化判断】|用户原始提示词/.test(prompt)) {
    return TEXT_CARD_WORKFLOW_LABELS.promptOptimizer;
  }
  if (input.action === "generate" || /阶段二[｜·]?D5场景目标图|按提示词生成图片/.test(prompt)) {
    return TEXT_CARD_WORKFLOW_LABELS.sceneGenerate;
  }
  if (
    input.hasStyleReference
    || /有参考图|参考附件\s*2|附件\s*2[^。\n]*(?:风格|氛围|参考)/.test(prompt)
  ) return TEXT_CARD_WORKFLOW_LABELS.sceneReference;
  if (input.workflowStage === "scene-optimization" || input.kind === "prompt") {
    return TEXT_CARD_WORKFLOW_LABELS.sceneDirection;
  }
  return input.action === "analyze" ? TEXT_CARD_WORKFLOW_LABELS.preflight : "返回文字结果";
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

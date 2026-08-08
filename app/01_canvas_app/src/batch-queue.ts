import type { ImageNodeState } from "./canvas-layout.js";
import type { CanvasBatchItem, CanvasBatchRun } from "./project-state.js";
import type { ImageRole, ResponseMode } from "@gpt-canvas/shared";

export interface BatchProgress {
  total: number;
  completed: number;
  failed: number;
  remaining: number;
  percent: number;
}

export const WORKFLOW_ACTIONS = ["analyze", "prompt", "generate"] as const;
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];

export const WORKFLOW_ACTION_LABELS: Readonly<Record<WorkflowAction, string>> = {
  analyze: "分析图片",
  prompt: "生成／优化提示词",
  generate: "按提示词生成图片"
};

export const WORKFLOW_STAGE_ACTIONS: Readonly<Record<NonNullable<CanvasBatchRun["workflowStage"]>, readonly WorkflowAction[]>> = {
  preflight: ["analyze"],
  "scene-optimization": ["prompt", "generate"],
  "final-glass": ["generate"],
  completed: []
};

export function workflowActionAllowed(
  stage: NonNullable<CanvasBatchRun["workflowStage"]>,
  action: WorkflowAction
): boolean {
  return WORKFLOW_STAGE_ACTIONS[stage].includes(action);
}

export function defaultWorkflowAction(stage: NonNullable<CanvasBatchRun["workflowStage"]>): WorkflowAction {
  return WORKFLOW_STAGE_ACTIONS[stage][0] ?? "analyze";
}

export function createCanvasBatchRun(
  sources: readonly ImageNodeState[],
  prompt: string,
  styleReferenceVersionId: `version_${string}` | null,
  options: {
    promptMode?: "reference-edit" | "stage-only";
    workflowStage?: CanvasBatchRun["workflowStage"];
    targetChatUrl?: string | null;
    responseMode?: ResponseMode;
    workflowAction?: WorkflowAction;
    rulesetVersion?: string;
  } = {},
  now = new Date().toISOString()
): CanvasBatchRun {
  return {
    id: `batch_${crypto.randomUUID()}`,
    status: "ready",
    prompt: prompt.trim(),
    promptMode: options.promptMode ?? "reference-edit",
    workflowStage: options.workflowStage ?? null,
    responseMode: options.responseMode ?? "image",
    workflowAction: options.workflowAction ?? "generate",
    rulesetVersion: options.rulesetVersion,
    styleReferenceVersionId,
    targetChatUrl: options.targetChatUrl?.trim() || null,
    items: sources.map((source): CanvasBatchItem => ({
      id: `batch_item_${crypto.randomUUID()}`,
      sourceVersionId: source.versionId,
      sourceName: source.name,
      attachmentVersionIds: [source.versionId],
      attachmentRoles: ["structure-base"],
      status: "queued",
      taskId: null,
      resultVersionIds: [],
      error: ""
    })),
    createdAt: now,
    updatedAt: now
  };
}

interface StageBatchInput {
  sources: readonly ImageNodeState[];
  stage: NonNullable<CanvasBatchRun["workflowStage"]>;
  prompt: string;
  structureBase: ImageNodeState | null;
  styleReference: ImageNodeState | null;
  targetChatUrl: string;
  action: WorkflowAction;
  suReferenceBySourceVersionId?: ReadonlyMap<`version_${string}`, ImageNodeState>;
}

function item(
  source: ImageNodeState,
  attachments: readonly ImageNodeState[],
  roles: readonly ImageRole[]
): CanvasBatchItem {
  return {
    id: `batch_item_${crypto.randomUUID()}`,
    sourceVersionId: source.versionId,
    sourceName: source.name,
    attachmentVersionIds: attachments.map((attachment) => attachment.versionId),
    attachmentRoles: [...roles],
    status: "queued",
    taskId: null,
    resultVersionIds: [],
    error: ""
  };
}

export function createStageCanvasBatchRun(input: StageBatchInput, now = new Date().toISOString()): CanvasBatchRun {
  const sources = [...new Map(input.sources.map((source) => [source.versionId, source])).values()];
  if (!sources.length) throw new Error("请至少选择一张阶段输入图片");
  if (!workflowActionAllowed(input.stage, input.action)) {
    throw new Error(`${input.stage === "preflight" ? "前置阶段" : input.stage === "scene-optimization" ? "优化阶段" : input.stage === "final-glass" ? "最终阶段" : "已完成阶段"}不支持“${WORKFLOW_ACTION_LABELS[input.action]}”`);
  }
  let items: CanvasBatchItem[];
  if (input.stage === "preflight") {
    items = sources.map((source) => {
      const su = input.suReferenceBySourceVersionId?.get(source.versionId) ?? null;
      if (su?.versionId === source.versionId) throw new Error(`${source.name} 的 D5 图与 SU 参考不能是同一张图片`);
      return {
        ...item(source, su ? [source, su] : [source], su ? ["d5-locked-view", "su-reference"] : ["d5-locked-view"]),
        outputKind: "preflight-review" as const,
        resultTextCardId: null
      };
    });
  } else if (input.stage === "scene-optimization") {
    const candidates = sources.filter((source) => source.versionId !== input.styleReference?.versionId);
    if (!candidates.length) throw new Error("优化阶段缺少结构与构图依据图");
    items = candidates.map((source) => {
      const style = input.styleReference && input.styleReference.versionId !== source.versionId
        ? input.styleReference
        : null;
      return {
        ...item(source, style ? [source, style] : [source], style
          ? ["structure-base", "style-reference"]
          : ["structure-base"]),
        outputKind: "d5-scene-target" as const
      };
    });
  } else if (input.stage === "final-glass") {
    items = sources.map((source) => ({
      ...item(source, [source], ["structure-base"]),
      outputKind: "glass-deepened-full-frame" as const
    }));
  } else {
    throw new Error("已完成阶段不能再建立生成任务");
  }
  return {
    id: `batch_${crypto.randomUUID()}`,
    status: "ready",
    prompt: input.prompt.trim(),
    promptMode: "stage-only",
    workflowStage: input.stage,
    responseMode: input.action === "generate" ? "image" : "text",
    workflowAction: input.action,
    rulesetVersion: "D5-RULESET-3.0",
    styleReferenceVersionId: input.styleReference?.versionId ?? null,
    targetChatUrl: input.targetChatUrl.trim() || null,
    items,
    createdAt: now,
    updatedAt: now
  };
}

export function nextQueuedBatchItem(run: CanvasBatchRun | null): CanvasBatchItem | null {
  return run?.items.find((item) => item.status === "queued") ?? null;
}

export function batchProgress(run: CanvasBatchRun | null): BatchProgress {
  const total = run?.items.length ?? 0;
  const completed = run?.items.filter((item) => item.status === "completed").length ?? 0;
  const failed = run?.items.filter((item) => item.status === "failed").length ?? 0;
  const remaining = Math.max(0, total - completed - failed);
  return {
    total,
    completed,
    failed,
    remaining,
    percent: total ? Math.round(((completed + failed) / total) * 100) : 0
  };
}

export function updateBatchItem(
  run: CanvasBatchRun,
  itemId: CanvasBatchItem["id"],
  patch: Partial<CanvasBatchItem>,
  now = new Date().toISOString()
): CanvasBatchRun {
  const items = run.items.map((item) => item.id === itemId ? { ...item, ...patch } : item);
  const finished = items.length > 0 && items.every((item) => item.status === "completed" || item.status === "failed");
  return {
    ...run,
    status: finished ? "completed" : run.status,
    items,
    updatedAt: now
  };
}

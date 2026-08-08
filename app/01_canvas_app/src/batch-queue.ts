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

export function defaultWorkflowAction(stage: NonNullable<CanvasBatchRun["workflowStage"]>): WorkflowAction {
  if (stage === "stage-3") return "prompt";
  if (stage === "stage-4") return "generate";
  return "analyze";
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
    targetChatUrl: options.targetChatUrl ?? null,
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
  let items: CanvasBatchItem[];
  if (input.stage === "stage-1") {
    if (sources.length > 3) throw new Error("阶段一一次最多比较三张候选视角");
    items = [item(sources[0]!, sources, sources.map(() => "content-reference"))];
  } else if (input.stage === "stage-2") {
    const d5 = input.structureBase && sources.some((source) => source.versionId === input.structureBase!.versionId)
      ? input.structureBase
      : null;
    const su = sources.find((source) => source.versionId !== d5?.versionId) ?? null;
    if (!d5 || !su || sources.length !== 2) {
      throw new Error("阶段二需选择两张图，并把锁定的D5正式视角设为“结构基准”；另一张作为对应SU截图");
    }
    items = [item(d5, [d5, su], ["d5-locked-view", "su-reference"])];
  } else if (input.stage === "stage-3") {
    const candidates = sources.filter((source) => source.versionId !== input.styleReference?.versionId);
    if (!candidates.length) throw new Error("阶段三缺少结构底图");
    items = candidates.map((source) => {
      const style = input.styleReference && input.styleReference.versionId !== source.versionId
        ? input.styleReference
        : null;
      return item(source, style ? [source, style] : [source], style
        ? ["structure-base", "style-reference"]
        : ["structure-base"]);
    });
  } else if (input.stage === "stage-4") {
    items = sources.map((source) => item(source, [source], ["structure-base"]));
  } else {
    items = sources.map((source) => input.structureBase && input.structureBase.versionId !== source.versionId
      ? item(source, [input.structureBase!, source], ["structure-base", "delivery-candidate"])
      : item(source, [source], ["delivery-candidate"]));
  }
  return {
    id: `batch_${crypto.randomUUID()}`,
    status: "ready",
    prompt: input.prompt.trim(),
    promptMode: "stage-only",
    workflowStage: input.stage,
    responseMode: input.action === "generate" ? "image" : "text",
    workflowAction: input.action,
    rulesetVersion: "D5-RULESET-2.0",
    styleReferenceVersionId: input.styleReference?.versionId ?? null,
    targetChatUrl: input.targetChatUrl,
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

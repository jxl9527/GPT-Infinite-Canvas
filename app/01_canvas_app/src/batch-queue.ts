import type { ImageNodeState } from "./canvas-layout.js";
import type { CanvasBatchItem, CanvasBatchRun } from "./project-state.js";
import type {
  ImageRole,
  ResponseMode,
  WorkflowRunAuthorization,
  WorkflowRunnerKind
} from "@gpt-canvas/shared";

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

export interface CodexStageAutomationPlan {
  action: WorkflowAction;
  label: string;
  detail: string;
}

const CODEX_STAGE_AUTOMATION_PLANS: Readonly<Record<NonNullable<CanvasBatchRun["workflowStage"]>, CodexStageAutomationPlan>> = {
  preflight: {
    action: "analyze",
    label: "分析图片",
    detail: "逐张审查视角、结构与修改意见，并在原图左侧登记文字卡"
  },
  "scene-optimization": {
    action: "generate",
    label: "提示词 → 生成图片",
    detail: "先生成并登记提示词，再按该提示词逐项生图，无需二次选择"
  },
  "final-glass": {
    action: "generate",
    label: "整图玻璃深化",
    detail: "逐张执行无蒙版最终 D5 整图玻璃深化并登记候选结果"
  },
  completed: {
    action: "analyze",
    label: "阶段已完成",
    detail: "请重新选择需要执行的独立阶段"
  }
};

export function codexStageAutomationPlan(
  stage: NonNullable<CanvasBatchRun["workflowStage"]>
): CodexStageAutomationPlan {
  return CODEX_STAGE_AUTOMATION_PLANS[stage];
}

export function selectCodexCanvasSources(
  selected: readonly ImageNodeState[],
  prepared: readonly ImageNodeState[],
  registered: readonly ImageNodeState[],
  importedFallback: readonly ImageNodeState[]
): ImageNodeState[] {
  const preferred = selected.length
    ? selected
    : prepared.length
      ? prepared
      : registered.length
        ? registered
        : importedFallback;
  return [...new Map(preferred.map((node) => [node.versionId, node])).values()];
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
    runner?: WorkflowRunnerKind;
    authorization?: WorkflowRunAuthorization | null;
    codexThreadId?: string | null;
  } = {},
  now = new Date().toISOString()
): CanvasBatchRun {
  const runner = options.runner ?? "manual";
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
    items: sources.map((source): CanvasBatchItem => {
      const id = `batch_item_${crypto.randomUUID()}` as const;
      return {
        id,
        sourceVersionId: source.versionId,
        sourceName: source.name,
        attachmentVersionIds: [source.versionId],
        attachmentRoles: ["structure-base"],
        status: "queued",
        taskId: null,
        resultVersionIds: [],
        error: "",
        runner,
        checkpoint: null,
        idempotencyKey: `${runner}:${source.versionId}:${id}`,
        attemptCount: 0,
        sourceHash: null,
        promptHash: null
      };
    }),
    runner,
    authorization: options.authorization ?? null,
    codexThreadId: options.codexThreadId?.trim() || null,
    leaseOwner: null,
    leaseExpiresAt: null,
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
  runner?: WorkflowRunnerKind;
  authorization?: WorkflowRunAuthorization | null;
  codexThreadId?: string | null;
}

function item(
  source: ImageNodeState,
  attachments: readonly ImageNodeState[],
  roles: readonly ImageRole[],
  runner: WorkflowRunnerKind
): CanvasBatchItem {
  const id = `batch_item_${crypto.randomUUID()}` as const;
  return {
    id,
    sourceVersionId: source.versionId,
    sourceName: source.name,
    attachmentVersionIds: attachments.map((attachment) => attachment.versionId),
    attachmentRoles: [...roles],
    status: "queued",
    taskId: null,
    resultVersionIds: [],
    error: "",
    runner,
    checkpoint: null,
    idempotencyKey: `${runner}:${source.versionId}:${id}`,
    attemptCount: 0,
    sourceHash: null,
    promptHash: null
  };
}

export function createStageCanvasBatchRun(input: StageBatchInput, now = new Date().toISOString()): CanvasBatchRun {
  const sources = [...new Map(input.sources.map((source) => [source.versionId, source])).values()];
  const runner = input.runner ?? "manual";
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
        ...item(source, su ? [source, su] : [source], su ? ["d5-locked-view", "su-reference"] : ["d5-locked-view"], runner),
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
          : ["structure-base"], runner),
        outputKind: "d5-scene-target" as const
      };
    });
  } else if (input.stage === "final-glass") {
    items = sources.map((source) => ({
      ...item(source, [source], ["structure-base"], runner),
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
    runner,
    authorization: input.authorization ?? null,
    codexThreadId: input.codexThreadId?.trim() || null,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: now,
    updatedAt: now
  };
}

export function nextQueuedBatchItem(run: CanvasBatchRun | null): CanvasBatchItem | null {
  return run?.items.find((item) => item.status === "queued") ?? null;
}

export function browserAutomationOwnsBatch(run: CanvasBatchRun | null): boolean {
  return Boolean(run && run.runner !== "codex");
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

import type {
  CanvasImageAsset,
  GenerationStatus,
  GenerationTask,
  ImageRole,
  ResponseMode,
  WorkflowRunAuthorization,
  WorkflowRunCheckpoint,
  WorkflowRunnerKind
} from "@gpt-canvas/shared";
import type { AnnotationState } from "./annotation-model.js";
import type { ImageNodeState } from "./canvas-layout.js";
import type { Viewport } from "./canvas-math.js";
import type { CanvasTextCard } from "./text-card.js";

export const WORKFLOW_STAGES = ["preflight", "scene-optimization", "final-glass", "completed"] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

export const LEGACY_WORKFLOW_STAGES = ["stage-1", "stage-2", "stage-3", "stage-4", "final"] as const;
export type LegacyWorkflowStage = (typeof LEGACY_WORKFLOW_STAGES)[number];

export const VIEWPOINT_STATUSES = ["not-started", "in-progress", "locked", "rework", "blocked"] as const;
export type ViewpointStatus = (typeof VIEWPOINT_STATUSES)[number];

export const HANDOFF_TARGETS = ["su", "d5", "gpt", "codex", "review"] as const;
export type HandoffTarget = (typeof HANDOFF_TARGETS)[number];

export type PreflightStatus = "pending" | "completed" | "not-run" | "external";
export type SceneOptimizationStatus = "pending" | "prompt-ready" | "generated" | "selected" | "not-run";
export type FinalGlassStatus = "pending" | "generated" | "selected" | "not-run";
export type GlassValidationStatus = "pending" | "passed" | "failed";
export type ViewpointExportStatus = "pending" | "partial" | "completed";
export const CANDIDATE_REVIEW_KEYS = ["structure", "facade", "site", "material", "atmosphere"] as const;

export function canvasRevisionRequiresSave(
  revision: number,
  lastSavedRevision: number,
  forceSnapshot = false
): boolean {
  return forceSnapshot || revision > lastSavedRevision;
}
export type CandidateReviewKey = (typeof CANDIDATE_REVIEW_KEYS)[number];
export type CandidateReviewCheck = "pending" | "passed" | "failed";
export type CandidateReviewDecision = "pending" | "approved" | "rejected";

export interface CandidateReviewRecord {
  versionId: `version_${string}`;
  stage: "scene-optimization" | "final-glass";
  checks: Record<CandidateReviewKey, CandidateReviewCheck>;
  decision: CandidateReviewDecision;
  note: string;
  updatedAt: string;
}

export interface ViewpointPreflightState {
  d5ViewVersionId: `version_${string}` | null;
  suReferenceVersionId: `version_${string}` | null;
  conclusionCardId: `text_card_${string}` | null;
  status: PreflightStatus;
}

export interface ViewpointSceneOptimizationState {
  structureBaseVersionId: `version_${string}` | null;
  styleReferenceVersionId: `version_${string}` | null;
  promptCardId: `text_card_${string}` | null;
  candidateVersionIds: `version_${string}`[];
  selectedVersionId: `version_${string}` | null;
  status: SceneOptimizationStatus;
}

export interface ViewpointFinalGlassState {
  finalD5VersionId: `version_${string}` | null;
  candidateVersionIds: `version_${string}`[];
  selectedVersionIds: `version_${string}`[];
  validation: GlassValidationStatus;
  status: FinalGlassStatus;
}

export interface ViewpointExportState {
  targetDirectory: string | null;
  exportedVersionIds: `version_${string}`[];
  exportedFiles: string[];
  exportedAt: string | null;
  status: ViewpointExportStatus;
}

export interface ViewpointStatusCard {
  id: `viewpoint_${string}`;
  name: string;
  purpose: string;
  stage: WorkflowStage;
  status: ViewpointStatus;
  statusMode?: "auto" | "manual";
  d5Batch: string;
  sourceVersionId: `version_${string}` | null;
  selectedVersionId: `version_${string}` | null;
  conclusion: string;
  nextAction: string;
  preflight: ViewpointPreflightState;
  sceneOptimization: ViewpointSceneOptimizationState;
  finalGlass: ViewpointFinalGlassState;
  export: ViewpointExportState;
  candidateReviews: CandidateReviewRecord[];
  updatedAt: string;
}

export interface StandardHandoffRecord {
  id: `handoff_${string}`;
  viewpointId: `viewpoint_${string}`;
  viewpointName: string;
  stage: WorkflowStage;
  status: ViewpointStatus;
  target: HandoffTarget;
  d5Batch: string;
  sourceVersionId: `version_${string}` | null;
  selectedVersionId: `version_${string}` | null;
  taskId: `task_${string}` | null;
  conclusion: string;
  nextAction: string;
  createdAt: string;
}

export const BATCH_RUN_STATUSES = ["ready", "running", "paused", "completed"] as const;
export type BatchRunStatus = (typeof BATCH_RUN_STATUSES)[number];

export const BATCH_ITEM_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type BatchItemStatus = (typeof BATCH_ITEM_STATUSES)[number];

export interface CanvasBatchItem {
  id: `batch_item_${string}`;
  sourceVersionId: `version_${string}`;
  sourceName: string;
  attachmentVersionIds?: `version_${string}`[];
  attachmentRoles?: ImageRole[];
  outputKind?: "preflight-review" | "d5-scene-target" | "glass-deepened-full-frame";
  resultTextCardId?: `text_card_${string}` | null;
  inputTextCardId?: `text_card_${string}` | null;
  inputPrompt?: string | null;
  status: BatchItemStatus;
  taskId: `task_${string}` | null;
  resultVersionIds: `version_${string}`[];
  error: string;
  runner?: WorkflowRunnerKind;
  checkpoint?: WorkflowRunCheckpoint | null;
  idempotencyKey?: string;
  attemptCount?: number;
  sourceHash?: string | null;
  promptHash?: string | null;
}

export interface CanvasBatchRun {
  id: `batch_${string}`;
  status: BatchRunStatus;
  prompt: string;
  promptMode?: "reference-edit" | "stage-only";
  workflowStage?: WorkflowStage | null;
  responseMode?: ResponseMode;
  workflowAction?: "analyze" | "prompt" | "generate";
  rulesetVersion?: string;
  styleReferenceVersionId: `version_${string}` | null;
  targetChatUrl?: string | null;
  items: CanvasBatchItem[];
  runner?: WorkflowRunnerKind;
  authorization?: WorkflowRunAuthorization | null;
  codexThreadId?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasWorkflowState {
  activeViewpointId: `viewpoint_${string}` | null;
  viewpoints: ViewpointStatusCard[];
  handoffs: StandardHandoffRecord[];
  batchRun: CanvasBatchRun | null;
  customGptUrl: string;
  customGptEnabled: boolean;
  textCards: CanvasTextCard[];
}

type VersionId = `version_${string}`;

function v3Stage(stage: WorkflowStage | LegacyWorkflowStage | undefined): WorkflowStage {
  if (stage === "stage-1" || stage === "stage-2") return "preflight";
  if (stage === "stage-3") return "scene-optimization";
  if (stage === "stage-4") return "final-glass";
  if (stage === "final") return "final-glass";
  return stage && (WORKFLOW_STAGES as readonly string[]).includes(stage) ? stage as WorkflowStage : "preflight";
}

export function createViewpointStatusCard(input: {
  id?: `viewpoint_${string}`;
  name: string;
  purpose?: string;
  stage?: WorkflowStage;
  d5Batch?: string;
  sourceVersionId?: VersionId | null;
  selectedVersionId?: VersionId | null;
  updatedAt?: string;
}): ViewpointStatusCard {
  const stage = input.stage ?? "preflight";
  const sourceVersionId = input.sourceVersionId ?? null;
  const selectedVersionId = input.selectedVersionId ?? null;
  const now = input.updatedAt ?? new Date().toISOString();
  return {
    id: input.id ?? `viewpoint_${crypto.randomUUID()}`,
    name: input.name,
    purpose: input.purpose ?? "",
    stage,
    status: "not-started",
    statusMode: "auto",
    d5Batch: input.d5Batch ?? "",
    sourceVersionId,
    selectedVersionId,
    conclusion: "",
    nextAction: "",
    preflight: {
      d5ViewVersionId: stage === "preflight" ? sourceVersionId : null,
      suReferenceVersionId: null,
      conclusionCardId: null,
      status: stage === "preflight" ? "pending" : "not-run"
    },
    sceneOptimization: {
      structureBaseVersionId: stage === "scene-optimization" ? sourceVersionId : null,
      styleReferenceVersionId: null,
      promptCardId: null,
      candidateVersionIds: [],
      selectedVersionId: stage === "scene-optimization" ? selectedVersionId : null,
      status: stage === "scene-optimization" ? (selectedVersionId ? "selected" : "pending") : "not-run"
    },
    finalGlass: {
      finalD5VersionId: stage === "final-glass" || stage === "completed" ? sourceVersionId : null,
      candidateVersionIds: [],
      selectedVersionIds: stage === "final-glass" || stage === "completed" ? (selectedVersionId ? [selectedVersionId] : []) : [],
      validation: selectedVersionId ? "passed" : "pending",
      status: stage === "final-glass" || stage === "completed" ? (selectedVersionId ? "selected" : "pending") : "not-run"
    },
    export: {
      targetDirectory: null,
      exportedVersionIds: [],
      exportedFiles: [],
      exportedAt: null,
      status: stage === "completed" ? "completed" : "pending"
    },
    candidateReviews: [],
    updatedAt: now
  };
}

function normalizedCandidateReview(review: CandidateReviewRecord): CandidateReviewRecord {
  const checks = Object.fromEntries(CANDIDATE_REVIEW_KEYS.map((key) => [
    key,
    review.checks?.[key] === "passed" || review.checks?.[key] === "failed" ? review.checks[key] : "pending"
  ])) as Record<CandidateReviewKey, CandidateReviewCheck>;
  return {
    versionId: review.versionId,
    stage: review.stage === "final-glass" ? "final-glass" : "scene-optimization",
    checks,
    decision: review.decision === "approved" || review.decision === "rejected" ? review.decision : "pending",
    note: typeof review.note === "string" ? review.note.slice(0, 1000) : "",
    updatedAt: typeof review.updatedAt === "string" && review.updatedAt ? review.updatedAt : new Date().toISOString()
  };
}

function normalizedViewpoint(raw: Partial<ViewpointStatusCard> & { stage?: WorkflowStage | LegacyWorkflowStage }): ViewpointStatusCard {
  const stage = v3Stage(raw.stage);
  const base = createViewpointStatusCard({
    id: raw.id,
    name: raw.name ?? "未命名视角",
    purpose: raw.purpose,
    stage,
    d5Batch: raw.d5Batch,
    sourceVersionId: raw.sourceVersionId ?? null,
    selectedVersionId: raw.selectedVersionId ?? null,
    updatedAt: raw.updatedAt
  });
  return {
    ...base,
    ...raw,
    stage,
    status: raw.status ?? base.status,
    statusMode: raw.statusMode === "manual" ? "manual" : "auto",
    preflight: { ...base.preflight, ...(raw.preflight ?? {}) },
    sceneOptimization: { ...base.sceneOptimization, ...(raw.sceneOptimization ?? {}) },
    finalGlass: { ...base.finalGlass, ...(raw.finalGlass ?? {}) },
    export: { ...base.export, ...(raw.export ?? {}) },
    candidateReviews: Array.isArray(raw.candidateReviews)
      ? raw.candidateReviews.map((review) => normalizedCandidateReview(review))
      : []
  } as ViewpointStatusCard;
}

function normalizedBatchRun(run: CanvasBatchRun | null): CanvasBatchRun | null {
  if (!run) return null;
  const rawStage = run.workflowStage as WorkflowStage | LegacyWorkflowStage | null | undefined;
  const legacyActive = Boolean(
    rawStage
    && (LEGACY_WORKFLOW_STAGES as readonly string[]).includes(rawStage)
    && run.status !== "completed"
  );
  return {
    ...structuredClone(run),
    runner: run.runner === "codex" ? "codex" : "manual",
    authorization: run.authorization ? structuredClone(run.authorization) : null,
    codexThreadId: typeof run.codexThreadId === "string" ? run.codexThreadId : null,
    leaseOwner: typeof run.leaseOwner === "string" ? run.leaseOwner : null,
    leaseExpiresAt: typeof run.leaseExpiresAt === "string" ? run.leaseExpiresAt : null,
    status: legacyActive ? "paused" : run.status,
    workflowStage: rawStage ? v3Stage(rawStage) : null,
    items: legacyActive
      ? run.items.map((item) => item.status === "queued" || item.status === "running"
        ? {
          ...item,
          runner: item.runner === "codex" ? "codex" : (run.runner === "codex" ? "codex" : "manual"),
          idempotencyKey: item.idempotencyKey || `legacy:${run.id}:${item.id}`,
          attemptCount: Number.isInteger(item.attemptCount) ? Math.max(0, item.attemptCount ?? 0) : 0,
          status: "failed",
          error: "旧四阶段批次已保留但不会自动续跑；请按V3三阶段规则重新建立批次"
        }
        : {
          ...structuredClone(item),
          runner: item.runner === "codex" ? "codex" : (run.runner === "codex" ? "codex" : "manual"),
          idempotencyKey: item.idempotencyKey || `legacy:${run.id}:${item.id}`,
          attemptCount: Number.isInteger(item.attemptCount) ? Math.max(0, item.attemptCount ?? 0) : 0
        })
      : run.items.map((item) => ({
        ...structuredClone(item),
        runner: item.runner === "codex" ? "codex" : (run.runner === "codex" ? "codex" : "manual"),
        idempotencyKey: item.idempotencyKey || `legacy:${run.id}:${item.id}`,
        attemptCount: Number.isInteger(item.attemptCount) ? Math.max(0, item.attemptCount ?? 0) : 0
      })),
    targetChatUrl: typeof run.targetChatUrl === "string" && run.targetChatUrl.trim()
      ? run.targetChatUrl.trim()
      : null
  };
}

function normalizedWorkflow(workflow: CanvasWorkflowState | undefined): CanvasWorkflowState {
  if (!workflow) return structuredClone(EMPTY_CANVAS_WORKFLOW);
  return {
    ...structuredClone(EMPTY_CANVAS_WORKFLOW),
    ...structuredClone(workflow),
    customGptEnabled: workflow.customGptEnabled === true,
    viewpoints: Array.isArray(workflow.viewpoints)
      ? workflow.viewpoints.map((viewpoint) => normalizedViewpoint(viewpoint))
      : [],
    handoffs: Array.isArray(workflow.handoffs)
      ? workflow.handoffs.map((handoff) => ({
        ...handoff,
        stage: v3Stage(handoff.stage as WorkflowStage | LegacyWorkflowStage),
        target: (handoff.target as string) === "photoshop" ? "review" : handoff.target
      }))
      : [],
    textCards: Array.isArray(workflow.textCards) ? structuredClone(workflow.textCards) : [],
    batchRun: normalizedBatchRun(workflow.batchRun ?? null)
  };
}

export function sanitizeCanvasWorkflowReferences(
  workflow: CanvasWorkflowState,
  validVersionIds: ReadonlySet<string>
): CanvasWorkflowState {
  const next = normalizedWorkflow(workflow);
  const valid = (versionId: `version_${string}` | null | undefined) => (
    versionId && validVersionIds.has(versionId) ? versionId : null
  );
  const validList = (versionIds: readonly `version_${string}`[]) => (
    versionIds.filter((versionId) => validVersionIds.has(versionId))
  );
  return {
    ...next,
    viewpoints: next.viewpoints.map((viewpoint) => {
      const sourceVersionId = valid(viewpoint.sourceVersionId);
      const selectedVersionId = valid(viewpoint.selectedVersionId);
      const sceneCandidates = validList(viewpoint.sceneOptimization.candidateVersionIds);
      const sceneSelected = valid(viewpoint.sceneOptimization.selectedVersionId);
      const finalCandidates = validList(viewpoint.finalGlass.candidateVersionIds);
      const finalSelected = validList(viewpoint.finalGlass.selectedVersionIds);
      const exportedPairs = viewpoint.export.exportedVersionIds.flatMap((versionId, index) => (
        validVersionIds.has(versionId)
          ? [{ versionId, file: viewpoint.export.exportedFiles[index] ?? "" }]
          : []
      ));
      const sceneStatus = sceneSelected
        ? "selected"
        : sceneCandidates.length
          ? "generated"
          : viewpoint.sceneOptimization.status === "generated" || viewpoint.sceneOptimization.status === "selected"
            ? "pending"
            : viewpoint.sceneOptimization.status;
      const finalStatus = finalSelected.length
        ? "selected"
        : finalCandidates.length
          ? "generated"
          : viewpoint.finalGlass.status === "generated" || viewpoint.finalGlass.status === "selected"
            ? "pending"
            : viewpoint.finalGlass.status;
      const exportStatus = exportedPairs.length === viewpoint.export.exportedVersionIds.length
        ? viewpoint.export.status
        : exportedPairs.length
          ? "partial"
          : "pending";
      return {
        ...viewpoint,
        sourceVersionId,
        selectedVersionId,
        preflight: {
          ...viewpoint.preflight,
          d5ViewVersionId: valid(viewpoint.preflight.d5ViewVersionId),
          suReferenceVersionId: valid(viewpoint.preflight.suReferenceVersionId)
        },
        sceneOptimization: {
          ...viewpoint.sceneOptimization,
          structureBaseVersionId: valid(viewpoint.sceneOptimization.structureBaseVersionId),
          styleReferenceVersionId: valid(viewpoint.sceneOptimization.styleReferenceVersionId),
          candidateVersionIds: sceneCandidates,
          selectedVersionId: sceneSelected,
          status: sceneStatus
        },
        finalGlass: {
          ...viewpoint.finalGlass,
          finalD5VersionId: valid(viewpoint.finalGlass.finalD5VersionId),
          candidateVersionIds: finalCandidates,
          selectedVersionIds: finalSelected,
          validation: finalSelected.length ? viewpoint.finalGlass.validation : "pending",
          status: finalStatus
        },
        export: {
          ...viewpoint.export,
          exportedVersionIds: exportedPairs.map((pair) => pair.versionId),
          exportedFiles: exportedPairs.map((pair) => pair.file),
          status: exportStatus
        },
        candidateReviews: viewpoint.candidateReviews
          .filter((review) => validVersionIds.has(review.versionId))
          .map((review) => normalizedCandidateReview(review))
      };
    }),
    handoffs: next.handoffs.map((handoff) => ({
      ...handoff,
      sourceVersionId: valid(handoff.sourceVersionId),
      selectedVersionId: valid(handoff.selectedVersionId)
    })),
    textCards: next.textCards.map((card) => ({
      ...card,
      sourceVersionId: valid(card.sourceVersionId)
    })),
    batchRun: next.batchRun
      ? {
        ...next.batchRun,
        styleReferenceVersionId: valid(next.batchRun.styleReferenceVersionId),
        items: next.batchRun.items.map((item) => ({
          ...item,
          attachmentVersionIds: item.attachmentVersionIds
            ? validList(item.attachmentVersionIds)
            : undefined,
          resultVersionIds: validList(item.resultVersionIds)
        }))
      }
      : null
  };
}

export const EMPTY_CANVAS_WORKFLOW: CanvasWorkflowState = {
  activeViewpointId: null,
  viewpoints: [],
  handoffs: [],
  batchRun: null,
  customGptUrl: "",
  customGptEnabled: false,
  textCards: []
};

export interface CanvasProjectNode {
  id: string;
  type: "image" | AnnotationState["type"];
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  zIndex: number;
  locked: boolean;
  visible: boolean;
  payload: Record<string, unknown>;
}

export interface CanvasProjectVersion {
  id: `version_${string}`;
  assetId: `asset_${string}`;
  origin: ImageNodeState["origin"];
  parentVersionId: `version_${string}` | null;
  taskId: `task_${string}` | null;
  createdAt: string;
}

export interface CanvasProjectTaskLink {
  taskId: `task_${string}`;
  parentVersionId: `version_${string}` | null;
  resultVersionIds: `version_${string}`[];
  status: GenerationStatus;
}

export interface CanvasProjectDocument {
  schemaVersion: "1.0" | "2.0";
  projectId: `project_${string}`;
  title: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  canvas: {
    viewport: Viewport;
    nodes: CanvasProjectNode[];
  };
  assets: CanvasImageAsset[];
  versions: CanvasProjectVersion[];
  taskLinks: CanvasProjectTaskLink[];
  workflow?: CanvasWorkflowState;
}

export interface ProjectBuildInput {
  projectId: `project_${string}`;
  title: string;
  createdAt: string;
  revision: number;
  viewport: Viewport;
  nodes: ImageNodeState[];
  annotations: AnnotationState[];
  assets: CanvasImageAsset[];
  generationTask: GenerationTask | null;
  taskParentVersionId: `version_${string}` | null;
  workflow: CanvasWorkflowState;
}

function annotationSize(annotation: AnnotationState): { width: number; height: number } {
  if (annotation.type === "rectangle") return { width: Math.abs(annotation.width), height: Math.abs(annotation.height) };
  if (annotation.type === "text") return { width: annotation.width, height: annotation.fontSize * 2 };
  const xs = annotation.points.filter((_, index) => index % 2 === 0);
  const ys = annotation.points.filter((_, index) => index % 2 === 1);
  return {
    width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
    height: Math.max(1, Math.max(...ys) - Math.min(...ys))
  };
}

export function buildCanvasProjectDocument(input: ProjectBuildInput): CanvasProjectDocument {
  const referencedAssetIds = new Set(input.nodes.map((node) => node.assetId));
  const assets = input.assets.filter((asset) => referencedAssetIds.has(asset.id));
  const assetIds = new Set(assets.map((asset) => asset.id));
  for (const node of input.nodes) {
    if (!assetIds.has(node.assetId)) throw new Error(`节点资产未登记：${node.assetId}`);
  }
  const versions = input.nodes.map((node): CanvasProjectVersion => ({
    id: node.versionId,
    assetId: node.assetId,
    origin: node.origin,
    parentVersionId: node.parentVersionId,
    taskId: node.taskId,
    createdAt: input.createdAt
  }));
  const workflow = sanitizeCanvasWorkflowReferences(
    input.workflow,
    new Set(versions.map((version) => version.id))
  );
  const imageNodes = input.nodes.map((node, index): CanvasProjectNode => ({
    id: node.id,
    type: "image",
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: index,
    locked: false,
    visible: true,
    payload: {
      imageVersionId: node.versionId,
      fit: "cover",
      name: node.name,
      outputRatio: node.outputRatio,
      sourceWidth: node.sourceWidth,
      sourceHeight: node.sourceHeight
    }
  }));
  const annotationNodes = input.annotations.map((annotation, index): CanvasProjectNode => {
    const size = annotationSize(annotation);
    return {
      id: `node_annotation_${annotation.id.replace(/^annotation_/, "")}`,
      type: annotation.type,
      x: annotation.x,
      y: annotation.y,
      width: size.width,
      height: size.height,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      zIndex: imageNodes.length + index,
      locked: false,
      visible: true,
      payload: { annotation }
    };
  });
  const taskLinksById = new Map<string, CanvasProjectTaskLink>();
  for (const node of input.nodes) {
    if (!node.taskId) continue;
    const current = taskLinksById.get(node.taskId) ?? {
      taskId: node.taskId,
      parentVersionId: node.parentVersionId,
      resultVersionIds: [],
      status: input.generationTask?.id === node.taskId ? input.generationTask.status : "completed"
    };
    current.resultVersionIds.push(node.versionId);
    taskLinksById.set(node.taskId, current);
  }
  if (input.generationTask && !taskLinksById.has(input.generationTask.id)) {
    taskLinksById.set(input.generationTask.id, {
      taskId: input.generationTask.id,
      parentVersionId: input.taskParentVersionId,
      resultVersionIds: [],
      status: input.generationTask.status
    });
  }
  const now = new Date().toISOString();
  return {
    schemaVersion: "2.0",
    projectId: input.projectId,
    title: input.title,
    createdAt: input.createdAt,
    updatedAt: now,
    revision: input.revision,
    canvas: { viewport: input.viewport, nodes: [...imageNodes, ...annotationNodes] },
    assets,
    versions,
    taskLinks: [...taskLinksById.values()],
    workflow
  };
}

export interface RestoredProjectStructure {
  viewport: Viewport;
  imageNodes: Array<Omit<ImageNodeState, "src">>;
  annotations: AnnotationState[];
  taskParentVersionId: `version_${string}` | null;
  workflow: CanvasWorkflowState;
}

export function restoreCanvasProjectStructure(project: CanvasProjectDocument): RestoredProjectStructure {
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const versions = new Map(project.versions.map((version) => [version.id, version]));
  const imageNodes: Array<Omit<ImageNodeState, "src">> = [];
  const annotations: AnnotationState[] = [];
  for (const node of project.canvas.nodes) {
    if (node.type === "image") {
      const version = versions.get(String(node.payload.imageVersionId) as `version_${string}`);
      if (!version) throw new Error(`项目图片版本不存在：${String(node.payload.imageVersionId)}`);
      const asset = assets.get(version.assetId);
      if (!asset) throw new Error(`项目图片资产不存在：${version.assetId}`);
      imageNodes.push({
        id: node.id as `node_${string}`,
        assetId: asset.id,
        originalRelativePath: asset.original.relativePath,
        versionId: version.id,
        origin: version.origin,
        parentVersionId: version.parentVersionId,
        taskId: version.taskId,
        name: typeof node.payload.name === "string" ? node.payload.name : asset.originalName,
        sourceWidth: asset.original.width,
        sourceHeight: asset.original.height,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        outputRatio: (
          node.payload.outputRatio === "1:1"
          || node.payload.outputRatio === "4:3"
          || node.payload.outputRatio === "3:2"
          || node.payload.outputRatio === "16:9"
        ) ? node.payload.outputRatio : "free"
      });
    } else {
      const annotation = node.payload.annotation;
      if (annotation && typeof annotation === "object") annotations.push(annotation as AnnotationState);
    }
  }
  return {
    viewport: project.canvas.viewport,
    imageNodes,
    annotations,
    taskParentVersionId: project.taskLinks.at(-1)?.parentVersionId ?? null,
    workflow: normalizedWorkflow(project.workflow)
  };
}

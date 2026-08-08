import type {
  CanvasImageAsset,
  GenerationStatus,
  GenerationTask,
  ImageRole,
  ResponseMode
} from "@gpt-canvas/shared";
import type { AnnotationState } from "./annotation-model.js";
import type { ImageNodeState } from "./canvas-layout.js";
import type { Viewport } from "./canvas-math.js";
import type { CanvasTextCard } from "./text-card.js";

export const WORKFLOW_STAGES = ["stage-1", "stage-2", "stage-3", "stage-4", "final"] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];

export const VIEWPOINT_STATUSES = ["not-started", "in-progress", "locked", "rework", "blocked"] as const;
export type ViewpointStatus = (typeof VIEWPOINT_STATUSES)[number];

export const HANDOFF_TARGETS = ["su", "d5", "gpt", "codex", "photoshop", "review"] as const;
export type HandoffTarget = (typeof HANDOFF_TARGETS)[number];

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
  status: BatchItemStatus;
  taskId: `task_${string}` | null;
  resultVersionIds: `version_${string}`[];
  error: string;
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
  schemaVersion: "1.0";
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
    schemaVersion: "1.0",
    projectId: input.projectId,
    title: input.title,
    createdAt: input.createdAt,
    updatedAt: now,
    revision: input.revision,
    canvas: { viewport: input.viewport, nodes: [...imageNodes, ...annotationNodes] },
    assets,
    versions,
    taskLinks: [...taskLinksById.values()],
    workflow: structuredClone(input.workflow)
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
    workflow: project.workflow
      ? {
        ...structuredClone(EMPTY_CANVAS_WORKFLOW),
        ...structuredClone(project.workflow),
        customGptEnabled: project.workflow.customGptEnabled === true,
        textCards: Array.isArray(project.workflow.textCards)
          ? structuredClone(project.workflow.textCards)
          : [],
        batchRun: project.workflow.batchRun ? structuredClone(project.workflow.batchRun) : null
      }
      : structuredClone(EMPTY_CANVAS_WORKFLOW)
  };
}

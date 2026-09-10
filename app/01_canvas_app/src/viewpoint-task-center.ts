import type { ImageNodeState } from "./canvas-layout.js";
import {
  CANDIDATE_REVIEW_KEYS,
  type CandidateReviewCheck,
  type CandidateReviewKey,
  type CandidateReviewRecord,
  type CanvasBatchRun,
  type ViewpointStatusCard,
  type WorkflowStage
} from "./project-state.js";

export type ViewpointTaskFilter = "all" | "attention" | "review" | "selected" | "exported";
export type ViewpointTaskState = Exclude<ViewpointTaskFilter, "all"> | "idle";

export interface ViewpointCandidateSummary {
  versionId: `version_${string}`;
  nodeId: `node_${string}` | null;
  sourceName: string;
  displayName: string;
  stage: "scene-optimization" | "final-glass";
  review: CandidateReviewRecord;
  riskMessage: string;
  selected: boolean;
}

export interface ViewpointTaskSummary {
  viewpointId: `viewpoint_${string}`;
  name: string;
  purpose: string;
  stage: WorkflowStage;
  sourceVersionId: `version_${string}` | null;
  sourceName: string;
  state: ViewpointTaskState;
  candidateCount: number;
  selectedCount: number;
  riskCount: number;
  reviewedCount: number;
  nextAction: string;
  candidates: ViewpointCandidateSummary[];
}

export const CANDIDATE_REVIEW_LABELS: Readonly<Record<CandidateReviewKey, string>> = {
  structure: "体块与层数",
  facade: "门窗与幕墙",
  site: "道路与场地",
  material: "材质与光影",
  atmosphere: "植物与氛围"
};

export function createCandidateReviewRecord(
  versionId: `version_${string}`,
  stage: "scene-optimization" | "final-glass",
  current?: CandidateReviewRecord | null
): CandidateReviewRecord {
  if (current) return structuredClone(current);
  return {
    versionId,
    stage,
    checks: Object.fromEntries(CANDIDATE_REVIEW_KEYS.map((key) => [key, "pending"])) as Record<CandidateReviewKey, CandidateReviewCheck>,
    decision: "pending",
    note: "",
    updatedAt: new Date().toISOString()
  };
}

export function candidateReviewComplete(review: CandidateReviewRecord): boolean {
  return CANDIDATE_REVIEW_KEYS.every((key) => review.checks[key] === "passed");
}

export function updateCandidateReviewRecord(
  reviews: readonly CandidateReviewRecord[],
  versionId: `version_${string}`,
  stage: "scene-optimization" | "final-glass",
  update: (review: CandidateReviewRecord) => CandidateReviewRecord
): CandidateReviewRecord[] {
  const existing = reviews.find((review) => review.versionId === versionId) ?? null;
  const next = update(createCandidateReviewRecord(versionId, stage, existing));
  const normalized = { ...next, versionId, stage, updatedAt: new Date().toISOString() };
  return existing
    ? reviews.map((review) => review.versionId === versionId ? normalized : structuredClone(review))
    : [...reviews.map((review) => structuredClone(review)), normalized];
}

function stageCandidates(viewpoint: ViewpointStatusCard): {
  stage: "scene-optimization" | "final-glass";
  versionIds: `version_${string}`[];
  selectedVersionIds: `version_${string}`[];
} {
  if (viewpoint.stage === "final-glass" || viewpoint.stage === "completed" || viewpoint.finalGlass.candidateVersionIds.length) {
    return {
      stage: "final-glass",
      versionIds: viewpoint.finalGlass.candidateVersionIds,
      selectedVersionIds: viewpoint.finalGlass.selectedVersionIds
    };
  }
  return {
    stage: "scene-optimization",
    versionIds: viewpoint.sceneOptimization.candidateVersionIds,
    selectedVersionIds: viewpoint.sceneOptimization.selectedVersionId ? [viewpoint.sceneOptimization.selectedVersionId] : []
  };
}

function defaultNextAction(viewpoint: ViewpointStatusCard, candidates: readonly ViewpointCandidateSummary[]): string {
  if (viewpoint.export.status === "completed") return "成果已导出，可结束该视角任务";
  if (candidates.some((candidate) => candidate.selected)) return "核对采用版本并继续当前阶段";
  if (candidates.length) return "对比候选，按五项清单验收并选择采用版本";
  if (viewpoint.stage === "preflight") return "选择 D5 视角并发起构图与 SU 可见细节审查";
  if (viewpoint.stage === "scene-optimization") return "生成提示词与 D5 场景目标图";
  return "导入最终 D5 完整图并生成玻璃深化候选";
}

export function buildViewpointTaskSummaries(
  viewpoints: readonly ViewpointStatusCard[],
  nodes: readonly ImageNodeState[],
  batchRun: CanvasBatchRun | null
): ViewpointTaskSummary[] {
  const byVersionId = new Map(nodes.map((node) => [node.versionId, node]));
  const riskByVersionId = new Map<`version_${string}`, string>();
  for (const item of batchRun?.items ?? []) {
    if (item.status !== "failed" && !item.error) continue;
    for (const versionId of item.resultVersionIds) {
      riskByVersionId.set(versionId, item.error || "批次记录为失败候选，请人工复核结构");
    }
  }

  return viewpoints.map((viewpoint) => {
    const scope = stageCandidates(viewpoint);
    const candidates = scope.versionIds.map((versionId, index): ViewpointCandidateSummary => {
      const node = byVersionId.get(versionId) ?? null;
      const review = createCandidateReviewRecord(
        versionId,
        scope.stage,
        viewpoint.candidateReviews.find((record) => record.versionId === versionId)
      );
      const manualRisk = CANDIDATE_REVIEW_KEYS.some((key) => review.checks[key] === "failed") || review.decision === "rejected";
      return {
        versionId,
        nodeId: node?.id ?? null,
        sourceName: node?.name ?? versionId,
        displayName: `${viewpoint.name} · ${scope.stage === "final-glass" ? "玻璃候选" : "场景候选"} ${String(index + 1).padStart(2, "0")}`,
        stage: scope.stage,
        review,
        riskMessage: riskByVersionId.get(versionId) ?? (manualRisk ? review.note || "人工验收发现问题" : ""),
        selected: scope.selectedVersionIds.includes(versionId)
      };
    });
    const riskCount = candidates.filter((candidate) => Boolean(candidate.riskMessage)).length;
    const selectedCount = candidates.filter((candidate) => candidate.selected).length;
    const reviewedCount = candidates.filter((candidate) => candidate.review.decision !== "pending").length;
    const state: ViewpointTaskState = viewpoint.export.status === "completed"
      ? "exported"
      : viewpoint.status === "blocked" || viewpoint.status === "rework" || riskCount > 0
        ? "attention"
        : selectedCount > 0
          ? "selected"
          : candidates.length > 0
            ? "review"
            : "idle";
    const sourceVersionId = viewpoint.finalGlass.finalD5VersionId
      ?? viewpoint.sceneOptimization.structureBaseVersionId
      ?? viewpoint.preflight.d5ViewVersionId
      ?? viewpoint.sourceVersionId;
    return {
      viewpointId: viewpoint.id,
      name: viewpoint.name,
      purpose: viewpoint.purpose,
      stage: viewpoint.stage,
      sourceVersionId,
      sourceName: sourceVersionId ? readableSourceStem(byVersionId.get(sourceVersionId)?.name ?? "已关联底图") : "未关联底图",
      state,
      candidateCount: candidates.length,
      selectedCount,
      riskCount,
      reviewedCount,
      nextAction: viewpoint.nextAction.trim() || defaultNextAction(viewpoint, candidates),
      candidates
    };
  });
}

function readableSourceStem(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  if (!stem || /^(?:\d{8,}|[0-9a-f]{8}(?:\s+[0-9a-f]{4}){2,})$/i.test(stem)) return "未命名图像";
  return stem.length > 28 ? `${stem.slice(0, 28)}…` : stem;
}

export function businessCanvasNodeLabel(
  node: ImageNodeState,
  tasks: readonly ViewpointTaskSummary[],
  index: number
): string {
  for (const task of tasks) {
    const candidate = task.candidates.find((item) => item.versionId === node.versionId);
    if (candidate) return candidate.displayName;
    if (task.sourceVersionId === node.versionId) return `${task.name} · 阶段底图`;
  }
  const role = node.origin === "generated" ? "未归档候选" : "导入底图";
  return `${role} ${String(index + 1).padStart(2, "0")} · ${readableSourceStem(node.name)}`;
}

export function filterViewpointTasks(
  tasks: readonly ViewpointTaskSummary[],
  filter: ViewpointTaskFilter,
  query: string
): ViewpointTaskSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  return tasks.filter((task) => {
    if (filter !== "all" && task.state !== filter) return false;
    if (!normalizedQuery) return true;
    return [
      task.name,
      task.purpose,
      task.sourceName,
      task.nextAction,
      ...task.candidates.flatMap((candidate) => [
        candidate.displayName,
        candidate.sourceName,
        candidate.riskMessage,
        candidate.review.note
      ])
    ]
      .some((value) => value.toLocaleLowerCase("zh-CN").includes(normalizedQuery));
  });
}

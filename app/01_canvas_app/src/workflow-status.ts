import { isTerminalStatus, type GenerationTask } from "@gpt-canvas/shared";
import type { ImageNodeState } from "./canvas-layout.js";
import type { ViewpointStatus, ViewpointStatusCard } from "./project-state.js";

export interface ViewpointInference {
  status: ViewpointStatus;
  reason: string;
  mode: "auto" | "manual";
}

export function inferViewpointStatus(
  viewpoint: ViewpointStatusCard,
  nodes: ImageNodeState[],
  activeTask: GenerationTask | null,
  activeTaskParentVersionId: `version_${string}` | null
): ViewpointInference {
  if (viewpoint.statusMode === "manual") {
    return { status: viewpoint.status, reason: "状态由人工覆盖", mode: "manual" };
  }
  const source = viewpoint.sourceVersionId
    ? nodes.find((node) => node.versionId === viewpoint.sourceVersionId) ?? null
    : null;
  const selected = viewpoint.selectedVersionId
    ? nodes.find((node) => node.versionId === viewpoint.selectedVersionId) ?? null
    : null;
  if (selected) return { status: "locked", reason: "已登记采用成果", mode: "auto" };
  if (!source) return { status: "blocked", reason: "缺少结构／底图", mode: "auto" };
  const taskMatches = Boolean(
    activeTask
    && !isTerminalStatus(activeTask.status)
    && (
      activeTaskParentVersionId === source.versionId
      || activeTask.id === source.taskId
      || nodes.some((node) => node.taskId === activeTask.id && node.parentVersionId === source.versionId)
    )
  );
  if (taskMatches) return { status: "in-progress", reason: "关联任务正在执行", mode: "auto" };
  const candidates = nodes.filter((node) => node.parentVersionId === source.versionId);
  if (candidates.length) {
    return { status: "in-progress", reason: `已有 ${candidates.length} 个候选版本待确认`, mode: "auto" };
  }
  if (viewpoint.conclusion.trim() || viewpoint.nextAction.trim()) {
    return { status: "in-progress", reason: "已有阶段记录，尚未采用成果", mode: "auto" };
  }
  return { status: "not-started", reason: "底图已登记，尚无生成或采用记录", mode: "auto" };
}

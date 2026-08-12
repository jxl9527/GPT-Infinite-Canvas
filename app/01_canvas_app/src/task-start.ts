import type { WorkflowStage } from "./project-state.js";

export const TASK_START_DISMISSED_STORAGE_KEY = "gpt-canvas:task-start:v3-dismissed";

export interface TaskStartOption {
  stage: Exclude<WorkflowStage, "completed">;
  eyebrow: string;
  title: string;
  description: string;
  inputHint: string;
}

export const TASK_START_OPTIONS: readonly TaskStartOption[] = [
  {
    stage: "preflight",
    eyebrow: "阶段一",
    title: "构图与 SU 审查",
    description: "从 D5 视角开始，锁定相机与构图，并按需核对同方向 SU 可见细节。",
    inputHint: "导入 D5 视角；SU 截图稍后按视角配对。"
  },
  {
    stage: "scene-optimization",
    eyebrow: "阶段二",
    title: "场景优化",
    description: "以结构底图为唯一建筑依据，生成提示词与 D5 场景目标图。",
    inputHint: "导入结构底图；风格参考稍后单独指定。"
  },
  {
    stage: "final-glass",
    eyebrow: "阶段三",
    title: "最终玻璃深化",
    description: "从最终 D5 完整图开始，只深化玻璃材质与反射，保持完整画幅。",
    inputHint: "只导入最终 D5 完整图，不使用蒙版或通道图。"
  }
] as const;

export function shouldShowTaskStart(projectLoaded: boolean, imageCount: number, dismissed: boolean): boolean {
  return projectLoaded && imageCount === 0 && !dismissed;
}

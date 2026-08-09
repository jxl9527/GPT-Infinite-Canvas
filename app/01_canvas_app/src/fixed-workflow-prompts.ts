import type { WorkflowAction } from "./batch-queue.js";
import type { WorkflowStage } from "./project-state.js";

export interface FixedWorkflowPrompt {
  id: `fixed_${string}`;
  title: string;
  summary: string;
  stage: WorkflowStage | null;
  action?: WorkflowAction;
  content: string;
}

const STRUCTURE_GUARD = `附件中的本项目D5图是唯一结构与构图依据。必须保持建筑数量、体块、比例、层数、屋顶、入口、门窗、幕墙分格、道路、场地边界、相机、透视、画幅和裁切不变。参考图只能影响光影、色彩、材质感觉、配景密度和氛围，不得提供建筑设计。`;

const STAGE_ACTION_PROMPTS: Readonly<Record<WorkflowStage, Readonly<Record<WorkflowAction, string>>>> = {
  preflight: {
    analyze: `【画布工作流执行｜分析图片】\n阶段一｜前置阶段\n本轮只分析当前这一张已选定的D5视角并返回文字，不与其他视角比较，不生成图片。附件1为D5视角；附件2如有，是与该视角一一配对的SU截图。请输出：\n【视角结论】一句话\n【主要问题】最多3项\n【相机与构图调整】明确焦距、相机高度、俯仰、建筑占比、留白或裁切动作\n【SU可见细节】按P1／P2／P3最多5项；无SU截图时只判断画面可见问题，不虚构模型状态\n【交给D5／不值得制作】\n【唯一下一步】只写一项`,
    prompt: `【画布工作流边界】\n前置阶段固定返回分析文字，不生成提示词。`,
    generate: `【画布工作流边界】\n前置阶段固定返回分析文字，不生成图片。`
  },
  "scene-optimization": {
    analyze: `【画布工作流边界】\n优化阶段不设置独立分析动作；请使用“生成／优化提示词”。`,
    prompt: `【画布工作流执行｜生成／优化提示词】\n阶段二｜优化阶段\n本轮只返回文字，不生成图片。附件1为本项目唯一结构与构图依据；附件2如有，仅参考色彩、材质、光影、配景和氛围。请输出：\n【D5调整建议】最多三项\n【最终生成提示词】一段可直接用于生成D5场景目标图的完整提示词\n【必须保持与禁止改变】结构保护和负面约束`,
    generate: `【画布工作流执行｜按提示词生成图片】\n阶段二｜D5场景目标图\n立即使用附件1作为唯一编辑底图生成一张完整画幅目标图；附件2如有只提供视觉风格。必须返回可见图片，并明确说明：本图仅用于D5深化参考，不是结构依据或最终交付图。`
  },
  "final-glass": {
    analyze: `【画布工作流边界】\n最终阶段固定执行整图玻璃深化，不设置独立分析任务。`,
    prompt: `【画布工作流边界】\n最终阶段使用固定玻璃深化规则，不需要先生成提示词。`,
    generate: `【画布工作流执行｜按提示词生成图片】\n阶段三｜最终阶段·整图玻璃深化\n附件1是最终D5完整效果图，也是唯一编辑底图。不需要也不得索要蒙版、Transparent、AO、Material ID、SU截图或其他后期通道。请直接返回一张完整效果图，不得返回局部裁切、扩图或透明玻璃素材。\n下部及首层玻璃：以真实、克制的暖色室内内透和入口纵深为主，同时保留适量室外反射，避免贴室内照片。\n上部玻璃：以蓝灰天空、树木和环境冷色反射为主，只保留很弱的楼板、顶棚和室内暗部，不让整层同时发光。\n必须保持原图宽高比例、完整画幅、裁切、相机、透视、建筑位置、门窗洞口、窗框、每块窗格、墙面、道路、树木、人物车辆、天空和光线方向。不得增加清晰家具、明显人物、文字、标识或水印。`
  },
  completed: {
    analyze: `【画布工作流边界】\n该视角已经完成批量导出，画布任务结束。`,
    prompt: `【画布工作流边界】\n该视角已经完成批量导出，画布任务结束。`,
    generate: `【画布工作流边界】\n该视角已经完成批量导出，画布任务结束。`
  }
};

export interface WorkflowTaskSnapshot {
  projectName: string;
  viewpointName?: string;
  projectContext?: string;
  rulesetVersion?: string;
  sourceAspectRatio?: string;
  attachments?: readonly { index: number; role: string; name: string }[];
}

export function workflowStagePrompt(
  stage: WorkflowStage,
  action: WorkflowAction,
  snapshot?: WorkflowTaskSnapshot
): string {
  const base = [STAGE_ACTION_PROMPTS[stage][action], STRUCTURE_GUARD];
  if (!snapshot) return base.join("\n\n");
  const context = snapshot.projectContext?.trim().slice(0, 1_200) ?? "";
  const manifest = snapshot.attachments?.map((attachment) => (
    `- 附件${attachment.index}｜${attachment.role}｜${attachment.name}`
  )) ?? [];
  return [
    ...base,
    "",
    "【画布状态快照｜本轮唯一状态依据】",
    `- 规则版本：${snapshot.rulesetVersion ?? "D5-RULESET-3.0"}`,
    `- 项目：${snapshot.projectName}`,
    `- 视角／底图：${snapshot.viewpointName?.trim() || "以本轮附件名称为准"}`,
    ...(snapshot.sourceAspectRatio ? [`- 原图宽高比例：${snapshot.sourceAspectRatio}；输出必须保持该比例和完整裁切`] : []),
    ...(manifest.length ? ["- 附件清单：", ...manifest] : []),
    ...(context ? ["- 项目约束摘要：", context] : []),
    "不要依赖其他聊天中的项目记忆；若与本快照冲突，以本快照和本轮附件为准。"
  ].join("\n");
}

/** 保留旧调用兼容；新代码应显式传入任务动作。 */
export function dedicatedGptStagePrompt(stage: WorkflowStage, snapshot?: WorkflowTaskSnapshot): string {
  const action: WorkflowAction = stage === "scene-optimization" ? "prompt" : stage === "final-glass" ? "generate" : "analyze";
  return workflowStagePrompt(stage, action, snapshot);
}

export function wrapPromptForAction(action: WorkflowAction, prompt: string): string {
  if (action === "generate") return prompt;
  const textOnlyPrompt = prompt
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("输出要求：请直接生成一张"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const instruction = action === "prompt"
    ? "本轮只生成或优化提示词，不生成图片。请保留用户意图，补全结构保护、空间位置、光影逻辑和禁止项，并把可直接使用的成稿放在【最终生成提示词】下。"
    : "本轮只分析图片并返回文字，不生成图片。结论应简洁、可执行，并明确下一步。";
  return `${instruction}\n\n${textOnlyPrompt}`.trim();
}

export const FIXED_WORKFLOW_PROMPTS: readonly FixedWorkflowPrompt[] = [
  {
    id: "fixed_preflight_review",
    title: "01｜前置阶段：构图＋SU细节",
    summary: "每个已选D5视角独立返回构图与可见SU细节建议",
    stage: "preflight",
    action: "analyze",
    content: `${STAGE_ACTION_PROMPTS.preflight.analyze}\n\n${STRUCTURE_GUARD}`
  },
  {
    id: "fixed_scene_reference_prompt",
    title: "02A｜有参考图生成场景提示词",
    summary: "参考配景、光影和氛围，底图仍是唯一结构依据",
    stage: "scene-optimization",
    action: "prompt",
    content: `${STAGE_ACTION_PROMPTS["scene-optimization"].prompt}\n\n模式：有参考图。提取参考图的时间、光线、影调、景观层次、人物车辆和摄影感，不复制参考建筑。\n\n${STRUCTURE_GUARD}`
  },
  {
    id: "fixed_scene_direction_prompt",
    title: "02B｜无参考图生成场景提示词",
    summary: "按日景、清晨、夕阳、人物和景观方向组织提示词",
    stage: "scene-optimization",
    action: "prompt",
    content: `${STAGE_ACTION_PROMPTS["scene-optimization"].prompt}\n\n模式：无参考图。方向：[日景／清晨／夕阳]；人物：[办公／学生／工人]；配景：[乔木／灌木／水景]；密度：[克制／适中]。没有填写的内容采用适合建筑投标汇报的克制默认方向。\n\n${STRUCTURE_GUARD}`
  },
  {
    id: "fixed_prompt_optimizer",
    title: "02C｜不完整提示词优化",
    summary: "保留原意，补齐位置、光影、保护规则和禁止项",
    stage: "scene-optimization",
    action: "prompt",
    content: `【不完整提示词优化】\n用户原始提示词：[粘贴原始提示词]\n只优化文字，不生成图片。不得改变用户的核心意图。输出【优化判断】【最终生成提示词】【必须保持与禁止改变】。\n\n${STRUCTURE_GUARD}`
  },
  {
    id: "fixed_scene_generate",
    title: "02D｜按提示词生成D5目标图",
    summary: "使用确认后的提示词生成完整D5氛围参考图",
    stage: "scene-optimization",
    action: "generate",
    content: `${STAGE_ACTION_PROMPTS["scene-optimization"].generate}\n\n[在此粘贴已确认的最终生成提示词]\n\n${STRUCTURE_GUARD}`
  },
  {
    id: "fixed_final_glass",
    title: "03｜最终阶段：整图玻璃深化",
    summary: "无蒙版整图返回，下部暖内透、上部冷反射",
    stage: "final-glass",
    action: "generate",
    content: `${STAGE_ACTION_PROMPTS["final-glass"].generate}\n\n${STRUCTURE_GUARD}`
  },
  {
    id: "fixed_continue_project",
    title: "继续当前项目",
    summary: "沿用已锁定状态，从上次唯一下一步继续",
    stage: null,
    content: `继续当前建筑表现项目。从上一次尚未完成的唯一下一步继续，不重新开始，不重复已经确认的结论，不推翻已经成立的相机、模型和风格。`
  }
] as const;

export function fixedWorkflowPromptById(id: string): FixedWorkflowPrompt | null {
  return FIXED_WORKFLOW_PROMPTS.find((prompt) => prompt.id === id) ?? null;
}

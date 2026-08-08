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
  "stage-1": {
    analyze: `【画布工作流执行｜分析图片】\n阶段一｜相机与构图\n本轮只对比附件中的候选视角并返回文字，不生成图片。最多指出三个主要问题，优先保留已有点位，并给出本轮唯一下一步。`,
    prompt: `【画布工作流执行｜生成／优化提示词】\n阶段一｜相机与构图\n根据附件整理一段可直接用于后续构图复核的提示词，不生成图片。提示词必须保护原建筑和场地。`,
    generate: `【画布工作流执行｜按提示词生成图片】\n阶段一只允许进行构图参考，不重新设计建筑。保持附件的建筑和场地关系，生成完整画幅的构图参考图。`
  },
  "stage-2": {
    analyze: `【画布工作流执行｜分析图片】\n阶段二｜SU可见细节\n附件1为锁定的D5正式视角，附件2为同方向SU截图。只审查当前画面可见且值得制作的细节，按P1／P2／P3给出最多五项，不生成图片。`,
    prompt: `【画布工作流执行｜生成／优化提示词】\n阶段二｜SU可见细节\n把当前正式视角中的可见细节问题整理成一段清晰、可执行的复核提示词，不生成图片。`,
    generate: `【画布工作流执行｜按提示词生成图片】\n阶段二不负责重绘建筑。若执行生成，只能形成细节目标参考，并严格保持D5正式视角和SU建筑关系。`
  },
  "stage-3": {
    analyze: `【画布工作流执行｜分析图片】\n阶段三｜D5场景深化\n只分析附件的光影、材质、景观、人物车辆和氛围方向，不生成图片。最后给出最重要的三个D5调整。`,
    prompt: `【画布工作流执行｜生成／优化提示词】\n阶段三｜D5场景提示词\n本轮只返回文字，不生成图片。附件1为本项目唯一结构与构图依据；附件2如有，仅参考配景、光影和氛围。请输出：\n【D5调整建议】最多三项\n【最终生成提示词】一段可直接用于GPT改图的完整提示词\n【必须保持与禁止改变】结构保护和负面约束`,
    generate: `【画布工作流执行｜按提示词生成图片】\n阶段三｜D5场景目标图\n立即使用附件1作为编辑底图生成一张完整画幅的D5风格与氛围参考图。附件2如有只提供视觉风格。返回可见图片，并在文字中说明它不是建筑结构依据或最终交付图。`
  },
  "stage-4": {
    analyze: `【画布工作流执行｜分析图片】\n阶段四｜整图玻璃深化\n输入只有最终D5完整效果图。分析首层玻璃内透与上层玻璃反射的问题，不要求蒙版，不生成图片。`,
    prompt: `【画布工作流执行｜生成／优化提示词】\n阶段四｜整图玻璃提示词\n输入只有最终D5完整效果图，不要求任何蒙版。请返回一段整图编辑提示词：首层及下部玻璃以克制暖色内透和入口纵深为主，上层玻璃以蓝灰天空和环境冷色反射为主、只保留弱内透；同时严格保护窗框、窗格、建筑、配景、相机、裁切和图幅比例。输出必须包含【最终生成提示词】和【必须保持与禁止改变】。`,
    generate: `【画布工作流执行｜按提示词生成图片】\n阶段四｜整图玻璃深化\n附件1是最终D5完整效果图，也是唯一编辑底图。不需要也不得索要蒙版。请直接返回一张完整效果图，不得返回局部裁切或透明玻璃素材。\n下部及首层玻璃：以真实、克制的暖色室内内透为主，表现入口大厅或公共空间纵深，同时保留适量室外反射，避免贴室内照片。\n上部玻璃：以蓝灰天空和环境冷色反射为主，只保留非常弱的楼板、顶棚和室内暗部，不让整层同时发光。\n必须保持原图宽高比例、完整画幅、裁切、相机、透视、建筑位置、门窗洞口、窗框、幕墙分格、墙面、道路、树木、人物车辆和光线方向。不得增加、删除或移动窗格，不得生成文字标识。结果用于PS人工提取玻璃区域。`
  },
  final: {
    analyze: `【画布工作流执行｜分析图片】\n最终成果检查\n只检查结构、场地、玻璃对齐、版本、尺寸和交付完整性，不生成图片。给出是否可交付及唯一下一步。`,
    prompt: `【画布工作流执行｜生成／优化提示词】\n最终成果检查\n把当前问题整理成一段最终复核提示词，不生成图片。`,
    generate: `【画布工作流执行｜按提示词生成图片】\n最终检查阶段不应重新设计画面；若执行生成，必须保持原成果结构与构图。`
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
    `- 规则版本：${snapshot.rulesetVersion ?? "D5-RULESET-2.0"}`,
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
  const action: WorkflowAction = stage === "stage-3" ? "prompt" : stage === "stage-4" ? "generate" : "analyze";
  return workflowStagePrompt(stage, action, snapshot);
}

export function wrapPromptForAction(action: WorkflowAction, prompt: string): string {
  if (action === "generate") return prompt;
  const instruction = action === "prompt"
    ? "本轮只生成或优化提示词，不生成图片。请保留用户意图，补全结构保护、空间位置、光影逻辑和禁止项，并把可直接使用的成稿放在【最终生成提示词】下。"
    : "本轮只分析图片并返回文字，不生成图片。结论应简洁、可执行，并明确下一步。";
  return `${instruction}\n\n${prompt}`.trim();
}

export const FIXED_WORKFLOW_PROMPTS: readonly FixedWorkflowPrompt[] = [
  {
    id: "fixed_stage_1_camera",
    title: "01｜构图与相机审查",
    summary: "对比关键候选视角，返回可执行文字结论",
    stage: "stage-1",
    action: "analyze",
    content: `${STAGE_ACTION_PROMPTS["stage-1"].analyze}\n\n${STRUCTURE_GUARD}\n\n请按“点位结论／最多三个问题／相机调整／唯一下一步”输出。`
  },
  {
    id: "fixed_stage_2_su",
    title: "02｜SU可见细节审查",
    summary: "只检查正式画面中看得见且值得制作的细节",
    stage: "stage-2",
    action: "analyze",
    content: `${STAGE_ACTION_PROMPTS["stage-2"].analyze}\n\n${STRUCTURE_GUARD}`
  },
  {
    id: "fixed_stage_3_reference_prompt",
    title: "03A｜有参考图反推场景提示词",
    summary: "参考配景、光影和氛围，底图仍是唯一结构依据",
    stage: "stage-3",
    action: "prompt",
    content: `${STAGE_ACTION_PROMPTS["stage-3"].prompt}\n\n模式：有参考图。提取参考图的时间、光线、影调、景观层次、人物车辆和摄影感，不复制参考建筑。\n\n${STRUCTURE_GUARD}`
  },
  {
    id: "fixed_stage_3_direction_prompt",
    title: "03B｜无参考图生成场景提示词",
    summary: "按日景、清晨、夕阳、人物和景观方向组织提示词",
    stage: "stage-3",
    action: "prompt",
    content: `${STAGE_ACTION_PROMPTS["stage-3"].prompt}\n\n模式：无参考图。方向：[日景／清晨／夕阳]；人物：[办公／学生／工人]；配景：[乔木／灌木／水景]；密度：[克制／适中]。没有填写的内容采用适合建筑投标汇报的克制默认方向。\n\n${STRUCTURE_GUARD}`
  },
  {
    id: "fixed_prompt_optimizer",
    title: "04｜不完整提示词优化",
    summary: "保留原意，补齐位置、光影、保护规则和禁止项",
    stage: "stage-3",
    action: "prompt",
    content: `【不完整提示词优化】\n用户原始提示词：[粘贴原始提示词]\n只优化文字，不生成图片。不得改变用户的核心意图。输出【优化判断】【最终生成提示词】【必须保持与禁止改变】。\n\n${STRUCTURE_GUARD}`
  },
  {
    id: "fixed_stage_3_generate",
    title: "05｜按提示词生成场景目标图",
    summary: "使用确认后的提示词生成完整D5氛围参考图",
    stage: "stage-3",
    action: "generate",
    content: `${STAGE_ACTION_PROMPTS["stage-3"].generate}\n\n[在此粘贴已确认的最终生成提示词]\n\n${STRUCTURE_GUARD}`
  },
  {
    id: "fixed_stage_4_glass",
    title: "06｜最终D5整图玻璃深化",
    summary: "无蒙版整图返回，下部暖内透、上部冷反射",
    stage: "stage-4",
    action: "generate",
    content: `${STAGE_ACTION_PROMPTS["stage-4"].generate}\n\n${STRUCTURE_GUARD}`
  },
  {
    id: "fixed_continue_project",
    title: "继续当前项目",
    summary: "沿用已锁定状态，从上次唯一下一步继续",
    stage: null,
    content: `继续当前建筑表现项目。从上一次尚未完成的唯一下一步继续，不重新开始，不重复已经确认的结论，不推翻已经成立的相机、模型和风格。`
  },
  {
    id: "fixed_stage_acceptance",
    title: "阶段验收与推进",
    summary: "只判断最低完成条件，不追加新的优化建议",
    stage: null,
    action: "analyze",
    content: `请对当前阶段进行验收，不增加新的优化建议。逐项判断已完成、尚未完成、无法判断及是否阻断；最后只给出“可以进入下一阶段”或最小必要事项。`
  }
] as const;

export function fixedWorkflowPromptById(id: string): FixedWorkflowPrompt | null {
  return FIXED_WORKFLOW_PROMPTS.find((prompt) => prompt.id === id) ?? null;
}

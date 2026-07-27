import type { ImageNodeState } from "./canvas-layout.js";
import type { ImageRole, TaskType } from "@gpt-canvas/shared";

export type ReferenceRole = "structure-base" | "style-reference";
export type GenerationMode = "reference-edit" | "concept-generation";

export interface TaskAttachmentPreview {
  order: 1 | 2;
  role: ImageRole;
  roleLabel: string;
  nodeId: ImageNodeState["id"];
  assetId: ImageNodeState["assetId"];
  name: string;
  relativePath: string;
}

export interface GenerationTaskPreview {
  ready: boolean;
  taskType: TaskType;
  includesProjectContext: boolean;
  prompt: string;
  attachments: TaskAttachmentPreview[];
  missing: string[];
}

const STRUCTURE_GUARD =
  "附件 1 是唯一的建筑与场地结构依据。必须严格保持建筑数量、体块关系、比例、朝向、道路关系、场地边界和原始视角；不得增加、删除、移动或重构建筑。";

const STYLE_GUARD =
  "附件 2 仅作为视觉风格参考，不得照搬其中的建筑、场地或构图。只允许参考色彩、材质、光影、线条、氛围、标注方式和环境表达。";

const SINGLE_IMAGE_GUARD =
  "只允许在附件 1 的结构基础上调整色彩、材质、光影、氛围与环境表达。";

const ANNOTATION_GUARD =
  "附件 1 是带批注副本：红色框选、箭头、画笔和文字仅表示修改区域与意见；底图仍是唯一结构依据。请逐项响应批注意见，严禁把红色批注线条生成到最终图中。";

const CONCEPT_REFERENCE =
  "附件 1 仅作为项目内容参考，请结合项目背景和修改要求生成，不得无依据改变图中已经明确的建筑与场地关系。";

export function buildGenerationTaskPreview(
  instruction: string,
  structureBase: ImageNodeState | null,
  styleReference: ImageNodeState | null,
  projectContext = "",
  mode: GenerationMode = "reference-edit",
  hasAnnotations = false
): GenerationTaskPreview {
  const normalizedInstruction = instruction.trim();
  const normalizedProjectContext = projectContext.trim().slice(0, 4_000);
  const includesProjectContext = mode === "concept-generation" && Boolean(normalizedProjectContext);
  const missing: string[] = [];
  if (mode === "reference-edit" && !structureBase) missing.push("结构基准");
  if (!normalizedInstruction) missing.push("修改要求");

  const attachments: TaskAttachmentPreview[] = [];
  if (structureBase) {
    attachments.push({
      order: 1,
      role: hasAnnotations
        ? "annotation-map"
        : mode === "reference-edit"
          ? "structure-base"
          : "content-reference",
      roleLabel: hasAnnotations
        ? "带批注参考图"
        : mode === "reference-edit"
          ? "结构基准"
          : "内容参考",
      nodeId: structureBase.id,
      assetId: structureBase.assetId,
      name: structureBase.name,
      relativePath: structureBase.originalRelativePath
    });
  }
  if (styleReference && styleReference.id !== structureBase?.id) {
    attachments.push({
      order: 2,
      role: "style-reference",
      roleLabel: "风格参考",
      nodeId: styleReference.id,
      assetId: styleReference.assetId,
      name: styleReference.name,
      relativePath: styleReference.originalRelativePath
    });
  }

  const prompt = normalizedInstruction
    ? mode === "reference-edit"
      ? [
        `[P2-REFERENCE-EDIT] ${normalizedInstruction}`,
        "",
        hasAnnotations ? ANNOTATION_GUARD : STRUCTURE_GUARD,
        attachments.length === 2 ? STYLE_GUARD : SINGLE_IMAGE_GUARD,
        "输出要求：保持原始画幅关系，生成一张可直接回收到当前画布的高质量建筑方案图。"
      ].join("\n")
      : [
        `[P2-CONCEPT-GENERATION] ${normalizedInstruction}`,
        "",
        ...(includesProjectContext
          ? [
            "项目背景与设计约束：",
            normalizedProjectContext,
            ""
          ]
          : []),
        ...(structureBase
          ? [hasAnnotations ? ANNOTATION_GUARD : CONCEPT_REFERENCE]
          : []),
        ...(attachments.length === 2 ? [STYLE_GUARD] : []),
        "输出要求：生成一张适合建筑方案汇报、分析图或投标表达的高质量图像。"
      ].join("\n")
    : "";

  return {
    ready: missing.length === 0,
    taskType: mode === "reference-edit" ? "edit" : "new",
    includesProjectContext,
    prompt,
    attachments,
    missing
  };
}

import { basename, extname } from "node:path";
import { ProtocolError } from "@gpt-canvas/shared";

export type ProjectRequirementKey =
  | "basic"
  | "scale"
  | "functions"
  | "scope"
  | "goals"
  | "constraints"
  | "expression"
  | "mustKeep"
  | "prohibited"
  | "supplementary";

export interface ProjectRequirementSection {
  key: ProjectRequirementKey | "other";
  label: string;
  heading: string;
  content: string;
}

export interface ProjectRequirementsPreview {
  sourceName: string;
  title: string;
  projectNameSuggestion: string;
  summary: string;
  generationContext: string;
  characterCount: number;
  recognizedSectionCount: number;
  sections: ProjectRequirementSection[];
  missingRecommended: string[];
}

const MAX_REQUIREMENTS_BYTES = 1_048_576;

const SECTION_DEFINITIONS: Array<{
  key: ProjectRequirementKey;
  label: string;
  aliases: string[];
}> = [
  { key: "basic", label: "项目基本信息", aliases: ["项目基本信息", "基本信息", "项目概况", "项目背景"] },
  { key: "scale", label: "建设规模", aliases: ["建设规模", "项目规模", "规模指标", "经济技术指标"] },
  { key: "functions", label: "主要功能", aliases: ["主要功能", "功能需求", "功能组成", "建设内容"] },
  { key: "scope", label: "设计范围", aliases: ["设计范围", "服务范围", "工作范围"] },
  { key: "goals", label: "设计目标", aliases: ["设计目标", "项目目标", "设计原则"] },
  { key: "constraints", label: "规划与技术条件", aliases: ["规划与技术条件", "规划条件", "技术条件", "设计条件", "限制条件"] },
  { key: "expression", label: "建筑表达要求", aliases: ["建筑表达要求", "成果要求", "表达要求", "图像要求"] },
  { key: "mustKeep", label: "必须保持的内容", aliases: ["必须保持的内容", "结构保护", "保留内容", "不变内容"] },
  { key: "prohibited", label: "禁止修改的内容", aliases: ["禁止修改的内容", "禁止事项", "不得修改"] },
  { key: "supplementary", label: "其他补充要求", aliases: ["其他补充要求", "补充要求", "其他要求"] }
];

function normalizeSourceName(value: unknown): string {
  if (typeof value !== "string") throw new ProtocolError("INVALID_INPUT", "请选择项目需求 Markdown 文件");
  const name = value.trim();
  if (
    !name
    || name.length > 120
    || basename(name) !== name
    || /[\u0000-\u001f<>:"/\\|?*]/.test(name)
  ) {
    throw new ProtocolError("INVALID_INPUT", "项目需求文件名无效");
  }
  if (![".md", ".markdown"].includes(extname(name).toLowerCase())) {
    throw new ProtocolError("INVALID_INPUT", "项目需求文件必须是 .md 或 .markdown");
  }
  return name;
}

function normalizeContent(value: unknown): string {
  if (typeof value !== "string") throw new ProtocolError("INVALID_INPUT", "项目需求 Markdown 内容为空");
  const content = value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!content) throw new ProtocolError("INVALID_INPUT", "项目需求 Markdown 内容为空");
  if (content.includes("\u0000")) throw new ProtocolError("INVALID_INPUT", "项目需求 Markdown 包含无效字符");
  if (Buffer.byteLength(content, "utf8") > MAX_REQUIREMENTS_BYTES) {
    throw new ProtocolError("INVALID_INPUT", "项目需求 Markdown 不得超过 1 MiB");
  }
  return `${content}\n`;
}

function cleanHeading(value: string): string {
  return value
    .replace(/\s+#+\s*$/, "")
    .replace(/^\s*(?:第\s*)?[一二三四五六七八九十百零0-9]+(?:\s*[.、．）):：-])?\s*/, "")
    .trim();
}

function plainText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[*_`>#|]/g, " ")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function matchSection(heading: string): { key: ProjectRequirementKey | "other"; label: string } {
  const normalized = cleanHeading(heading).replace(/\s+/g, "");
  const definition = SECTION_DEFINITIONS.find((candidate) => (
    candidate.aliases.some((alias) => normalized.includes(alias.replace(/\s+/g, "")))
  ));
  return definition
    ? { key: definition.key, label: definition.label }
    : { key: "other", label: cleanHeading(heading) || "其他内容" };
}

function projectNameFromContent(content: string): string {
  for (const line of content.split("\n")) {
    const match = line.match(/^\s*(?:[-*+]\s*)?(?:\*\*)?项目名称(?:\*\*)?\s*[：:]\s*(.+?)\s*$/);
    if (!match?.[1]) continue;
    const name = plainText(match[1]).slice(0, 40).trim();
    if (name) return name;
  }
  return "";
}

function parseSections(content: string): Array<{ level: number; heading: string; content: string }> {
  const sections: Array<{ level: number; heading: string; content: string }> = [];
  let current: { level: number; heading: string; lines: string[] } | null = null;
  let fenced = false;
  for (const line of content.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const heading = !fenced ? line.match(/^(#{1,6})\s+(.+?)\s*$/) : null;
    if (heading?.[1] && heading[2]) {
      if (current) {
        sections.push({
          level: current.level,
          heading: current.heading,
          content: current.lines.join("\n").trim()
        });
      }
      current = { level: heading[1].length, heading: heading[2], lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) {
    sections.push({
      level: current.level,
      heading: current.heading,
      content: current.lines.join("\n").trim()
    });
  }
  return sections;
}

export function parseProjectRequirements(
  sourceNameValue: unknown,
  contentValue: unknown
): { content: string; preview: ProjectRequirementsPreview } {
  const sourceName = normalizeSourceName(sourceNameValue);
  const content = normalizeContent(contentValue);
  const parsed = parseSections(content);
  const firstHeading = parsed[0]?.heading ? cleanHeading(parsed[0].heading) : "";
  const h1Suggestion = parsed.find((section) => (
    section.level === 1
    && !/^(?:项目需求|需求文档|项目背景资料)$/i.test(cleanHeading(section.heading))
  ));
  const projectNameSuggestion = (
    projectNameFromContent(content)
    || (h1Suggestion ? cleanHeading(h1Suggestion.heading) : "")
  ).slice(0, 40);
  const title = (
    /^(?:项目需求|需求文档|项目背景资料)$/i.test(firstHeading)
      ? projectNameSuggestion || firstHeading
      : firstHeading
  ) || sourceName.replace(/\.(?:md|markdown)$/i, "");

  const sections = parsed
    .filter((section) => section.content)
    .map<ProjectRequirementSection>((section) => {
      const matched = matchSection(section.heading);
      return {
        key: matched.key,
        label: matched.label,
        heading: cleanHeading(section.heading),
        content: section.content
      };
    });
  const recognized = sections.filter((section) => section.key !== "other");
  const orderedRecognized = SECTION_DEFINITIONS.flatMap((definition) => (
    recognized.filter((section) => section.key === definition.key)
  ));
  const generationParts = orderedRecognized.map((section) => (
    `## ${section.label}\n${section.content.trim()}`
  ));
  const fallbackBody = parsed
    .map((section) => section.content)
    .filter(Boolean)
    .join("\n\n")
    .trim();
  const generationContext = (
    generationParts.length
      ? `# 项目背景与设计约束\n\n${generationParts.join("\n\n")}`
      : `# 项目背景与设计约束\n\n${fallbackBody || content}`
  ).slice(0, 8_000).trim();
  const summarySource = orderedRecognized.length
    ? orderedRecognized.map((section) => section.content).join(" ")
    : fallbackBody || content;
  const summary = plainText(summarySource).slice(0, 280);
  const present = new Set(recognized.map((section) => section.key));
  const missingRecommended = SECTION_DEFINITIONS
    .filter((definition) => ["basic", "scale", "functions", "goals"].includes(definition.key))
    .filter((definition) => !present.has(definition.key))
    .map((definition) => definition.label);

  return {
    content,
    preview: {
      sourceName,
      title,
      projectNameSuggestion,
      summary,
      generationContext,
      characterCount: content.trimEnd().length,
      recognizedSectionCount: recognized.length,
      sections,
      missingRecommended
    }
  };
}

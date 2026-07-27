import test from "node:test";
import assert from "node:assert/strict";
import { parseProjectRequirements } from "../src/project-requirements.js";

const requirements = `# 项目需求

## 1. 项目基本信息

- 项目名称：开化县公共实训基地建设项目
- 建设地点：浙江省衢州市开化县
- 项目类型：公共建筑

## 2. 建设规模

- 建筑面积：32000 平方米

## 3. 主要功能

- 公共实训
- 教学配套

## 5. 设计目标

- 建立高效、开放的产教融合园区

## 8. 必须保持的内容

- 严格保持建筑数量、体块、道路和场地边界

## 9. 禁止修改的内容

- 不得增加、删除或移动建筑
`;

test("项目需求 Markdown 提取项目名称、结构化章节和生成上下文", () => {
  const result = parseProjectRequirements("项目需求.md", requirements);
  assert.equal(result.preview.projectNameSuggestion, "开化县公共实训基地建设项目");
  assert.equal(result.preview.title, "开化县公共实训基地建设项目");
  assert.equal(result.preview.recognizedSectionCount, 6);
  assert.deepEqual(result.preview.missingRecommended, []);
  assert.match(result.preview.generationContext, /## 必须保持的内容/);
  assert.match(result.preview.generationContext, /不得增加、删除或移动建筑/);
  assert.equal(result.content.endsWith("\n"), true);
});

test("标题不规范时保留全文作为生成上下文", () => {
  const result = parseProjectRequirements("任务书.markdown", "# 产业园方案\n\n本项目建设两栋厂房和一栋办公楼。");
  assert.equal(result.preview.projectNameSuggestion, "产业园方案");
  assert.equal(result.preview.recognizedSectionCount, 0);
  assert.match(result.preview.generationContext, /两栋厂房/);
  assert.deepEqual(result.preview.missingRecommended, ["项目基本信息", "建设规模", "主要功能", "设计目标"]);
});

test("拒绝非 Markdown 文件和超大内容", () => {
  assert.throws(() => parseProjectRequirements("需求.docx", "# 项目需求"), /必须是 .md/);
  assert.throws(
    () => parseProjectRequirements("需求.md", "汉".repeat(400_000)),
    /不得超过 1 MiB/
  );
});

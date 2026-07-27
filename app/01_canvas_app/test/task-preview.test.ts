import assert from "node:assert/strict";
import test from "node:test";
import type { ImageNodeState } from "../src/canvas-layout.js";
import { buildGenerationTaskPreview } from "../src/task-preview.js";

function node(id: string, name: string): ImageNodeState {
  return {
    id: `node_${id}`,
    assetId: `asset_${id}`,
    originalRelativePath: `assets/originals/asset_${id}.png`,
    versionId: `version_${id}`,
    origin: "imported",
    parentVersionId: null,
    taskId: null,
    name,
    src: "data:image/png;base64,AA==",
    sourceWidth: 1536,
    sourceHeight: 1024,
    x: 0,
    y: 0,
    width: 640,
    height: 427,
    outputRatio: "free"
  };
}

test("任务预览固定以结构基准为附件 1、风格参考为附件 2", () => {
  const preview = buildGenerationTaskPreview("优化夜景照明层次", node("structure", "结构图.png"), node("style", "风格图.png"));
  assert.equal(preview.ready, true);
  assert.deepEqual(preview.attachments.map((item) => [item.order, item.role, item.name]), [
    [1, "structure-base", "结构图.png"],
    [2, "style-reference", "风格图.png"]
  ]);
  assert.match(preview.prompt, /附件 1 是唯一的建筑与场地结构依据/);
  assert.match(preview.prompt, /附件 2 仅作为视觉风格参考/);
  assert.match(preview.prompt, /不得增加、删除、移动或重构建筑/);
});

test("缺少结构基准或修改要求时不得进入可创建状态", () => {
  const missingBoth = buildGenerationTaskPreview(" ", null, null);
  assert.equal(missingBoth.ready, false);
  assert.deepEqual(missingBoth.missing, ["结构基准", "修改要求"]);

  const sameNode = node("same", "同一张图.png");
  const sameRole = buildGenerationTaskPreview("优化材质", sameNode, sameNode);
  assert.equal(sameRole.attachments.length, 1);
  assert.match(sameRole.prompt, /只允许在附件 1 的结构基础上/);
});

test("已确认的项目需求上下文进入最终生成提示词", () => {
  const preview = buildGenerationTaskPreview(
    "提升入口空间层次",
    node("context", "结构图.png"),
    null,
    "# 项目背景与设计约束\n\n## 建设规模\n两栋厂房和一栋办公楼",
    "concept-generation"
  );
  assert.equal(preview.ready, true);
  assert.equal(preview.includesProjectContext, true);
  assert.match(preview.prompt, /两栋厂房和一栋办公楼/);
});

test("参考图改图模式不附加项目背景并保持提示词精简", () => {
  const preview = buildGenerationTaskPreview(
    "只调整立面材质",
    node("structure", "结构图.png"),
    null,
    "# 项目背景与设计约束\n\n两栋厂房和一栋办公楼",
    "reference-edit"
  );
  assert.equal(preview.includesProjectContext, false);
  assert.doesNotMatch(preview.prompt, /两栋厂房和一栋办公楼/);
  assert.equal(preview.taskType, "edit");
});

test("文生图模式允许不带参考图并附加项目背景", () => {
  const preview = buildGenerationTaskPreview(
    "生成产业园总图分析图",
    null,
    null,
    "# 项目背景与设计约束\n\n建设现代木业产业园",
    "concept-generation"
  );
  assert.equal(preview.ready, true);
  assert.equal(preview.attachments.length, 0);
  assert.equal(preview.taskType, "new");
  assert.match(preview.prompt, /建设现代木业产业园/);
});

test("存在批注时附件声明为批注图并明确不生成红线", () => {
  const preview = buildGenerationTaskPreview(
    "按批注调整入口",
    node("structure", "结构图.png"),
    null,
    "",
    "reference-edit",
    true
  );
  assert.equal(preview.attachments[0]?.role, "annotation-map");
  assert.match(preview.prompt, /带批注副本/);
  assert.match(preview.prompt, /严禁把红色批注线条生成到最终图中/);
});

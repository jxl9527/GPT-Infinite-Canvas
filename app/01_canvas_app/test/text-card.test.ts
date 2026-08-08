import assert from "node:assert/strict";
import test from "node:test";
import {
  alignedGlassFilename,
  aspectRatiosMatch,
  createCanvasTextCard,
  extractFinalPrompt,
  resizedTextCardSize
} from "../src/text-card.js";

test("文字结果在来源图片右侧形成可追溯提示词卡", () => {
  const card = createCanvasTextCard({
    kind: "prompt",
    title: "1人视｜提示词",
    text: "【最终生成提示词】\n保持建筑结构不变。",
    sourceVersionId: "version_source",
    taskId: "task_source",
    sourceBounds: { x: 100, y: 200, width: 640, height: 360 },
    now: "2026-08-07T00:00:00.000Z"
  });
  assert.equal(card.x, 812);
  assert.equal(card.y, 200);
  assert.equal(card.sourceVersionId, "version_source");
  assert.equal(card.kind, "prompt");
});

test("提示词卡优先提取最终生成提示词段落", () => {
  assert.equal(extractFinalPrompt([
    "【D5调整建议】",
    "调整树木。",
    "【最终生成提示词】",
    "保持建筑结构不变，增加克制景观。",
    "【必须保持与禁止改变】",
    "不得修改窗格。"
  ].join("\n")), "保持建筑结构不变，增加克制景观。");
});

test("文字卡按画布缩放比例自由调整宽高并保持最小可用尺寸", () => {
  assert.deepEqual(resizedTextCardSize(460, 360, 120, 80, 0.5), { width: 700, height: 520 });
  assert.deepEqual(resizedTextCardSize(460, 360, -1000, -1000), { width: 320, height: 240 });
});

test("玻璃整图只接受相同比例，并生成PS对齐文件名", () => {
  assert.equal(aspectRatiosMatch(3840, 2160, 1536, 864), true);
  assert.equal(aspectRatiosMatch(3840, 2160, 1536, 1024), false);
  assert.equal(alignedGlassFilename("1人视.png"), "1人视_PS对齐.png");
});

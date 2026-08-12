import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKBENCH_MAX_HEIGHT,
  WORKBENCH_MIN_HEIGHT,
  WORKBENCH_MAX_WIDTH,
  WORKBENCH_MIN_WIDTH,
  batchWorkbenchEntryVisible,
  batchWorkbenchStatus,
  appendUnifiedTaskRequirement,
  clampWorkbenchHeight,
  clampWorkbenchWidth,
  combinePromptText,
  deliveryWorkbenchStatus,
  placeSelectionContextPanel,
  previewWorkbenchStatus,
  promptWorkbenchStatus,
  resizedWorkbenchHeight,
  resizedWorkbenchWidth,
  selectionAfterTextCardHandoff,
  storedWorkbenchHeight,
  storedWorkbenchWidth,
  selectionContextMode
} from "../src/workbench-panel.js";

test("上下文工作台只跟随图片选择并区分单选与批选", () => {
  assert.equal(selectionContextMode(0), "hidden");
  assert.equal(selectionContextMode(1), "single");
  assert.equal(selectionContextMode(3), "batch");
  assert.equal(selectionContextMode(1, 1), "hidden");
});

test("载入文字卡提示词时清空文字卡选择并直接打开来源图片输入", () => {
  assert.deepEqual(selectionAfterTextCardHandoff("image_source"), {
    selectedId: "image_source",
    selectedNodeIds: ["image_source"],
    selectedAnnotationId: null,
    selectedTextCardId: null,
    selectedTextCardIds: []
  });
  assert.equal(selectionContextMode(1, 0), "single");
});

test("上下文工作台优先放在图片下方并避开右侧功能轨", () => {
  assert.deepEqual(placeSelectionContextPanel(
    { x: 100, y: 100, width: 640, height: 360 },
    { x: 0, y: 0, scale: 1 },
    { width: 1440, height: 900 },
    { height: 280 }
  ), { left: 100, top: 474, width: 640, placement: "below" });
  const clamped = placeSelectionContextPanel(
    { x: 1180, y: 160, width: 420, height: 260 },
    { x: 0, y: 0, scale: 1 },
    { width: 1440, height: 900 },
    { height: 280 }
  );
  assert.ok(clamped);
  assert.ok(clamped.left + clamped.width <= 1440 - 84);
});

test("提示词工作台高度受视口和安全边界约束", () => {
  assert.equal(clampWorkbenchHeight(80, 900), WORKBENCH_MIN_HEIGHT);
  assert.equal(clampWorkbenchHeight(900, 1200), WORKBENCH_MAX_HEIGHT);
  assert.equal(clampWorkbenchHeight(900, 500), 452);
});

test("向上拖动顶部边框会增大工作台", () => {
  assert.equal(resizedWorkbenchHeight(360, 700, 620, 1000), 440);
  assert.equal(resizedWorkbenchHeight(360, 700, 780, 1000), 280);
});

test("只恢复有效的已保存高度", () => {
  assert.equal(storedWorkbenchHeight("416", 900), 416);
  assert.equal(storedWorkbenchHeight("invalid", 900), null);
  assert.equal(storedWorkbenchHeight(null, 900), null);
});

test("提示词工作台默认宽度可限制在画布安全范围内", () => {
  assert.equal(clampWorkbenchWidth(320, 1920), WORKBENCH_MIN_WIDTH);
  assert.equal(clampWorkbenchWidth(1800, 1920), WORKBENCH_MAX_WIDTH);
  assert.equal(clampWorkbenchWidth(1200, 1000), 840);
  assert.equal(clampWorkbenchWidth(900, 680), 656);
});

test("左右边框都能以面板中心为基准调节宽度", () => {
  assert.equal(resizedWorkbenchWidth(1000, 300, 250, "left", 1920), 1100);
  assert.equal(resizedWorkbenchWidth(1000, 1600, 1650, "right", 1920), 1100);
  assert.equal(resizedWorkbenchWidth(1000, 300, 350, "left", 1920), 900);
});

test("只恢复有效的已保存宽度", () => {
  assert.equal(storedWorkbenchWidth("1184", 1920), 1184);
  assert.equal(storedWorkbenchWidth("invalid", 1920), null);
  assert.equal(storedWorkbenchWidth(null, 1920), null);
});

test("工作台入口状态使用带单位的明确语义", () => {
  assert.equal(batchWorkbenchStatus({ selectedCount: 2, preparedCount: 0, total: 0, completed: 0, failed: 0 }), "2张待发送");
  assert.equal(batchWorkbenchStatus({ selectedCount: 0, preparedCount: 0, total: 3, completed: 1, failed: 1 }), "2/3已处理");
  assert.equal(promptWorkbenchStatus(7), "7条");
  assert.equal(previewWorkbenchStatus(false, 2), "2项待补");
  assert.equal(previewWorkbenchStatus(true, 0), "已就绪");
  assert.equal(deliveryWorkbenchStatus(2, true), "2张可导出");
  assert.equal(deliveryWorkbenchStatus(0, false), "未就绪");
});

test("存在当前批次时必须显示可清除的工作台入口", () => {
  assert.equal(batchWorkbenchEntryVisible(false), false);
  assert.equal(batchWorkbenchEntryVisible(true), true);
});

test("套用提示词时明确区分替换与追加", () => {
  assert.equal(combinePromptText("当前要求", "预设内容", "replace"), "预设内容");
  assert.equal(combinePromptText("当前要求", "预设内容", "append"), "当前要求\n\n预设内容");
  assert.equal(combinePromptText("", "预设内容", "append"), "预设内容");
});

test("批量阶段提示词保留用户填写的统一任务要求", () => {
  assert.equal(
    appendUnifiedTaskRequirement("阶段规则", "统一降低树木遮挡"),
    "阶段规则\n\n【统一任务要求】\n统一降低树木遮挡"
  );
  assert.equal(appendUnifiedTaskRequirement("阶段规则", "  "), "阶段规则");
});

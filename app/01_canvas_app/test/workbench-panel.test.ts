import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKBENCH_MAX_HEIGHT,
  WORKBENCH_MIN_HEIGHT,
  WORKBENCH_MAX_WIDTH,
  WORKBENCH_MIN_WIDTH,
  clampWorkbenchHeight,
  clampWorkbenchWidth,
  resizedWorkbenchHeight,
  resizedWorkbenchWidth,
  storedWorkbenchHeight,
  storedWorkbenchWidth
} from "../src/workbench-panel.js";

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

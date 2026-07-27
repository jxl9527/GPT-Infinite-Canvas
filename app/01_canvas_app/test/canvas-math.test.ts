import assert from "node:assert/strict";
import test from "node:test";
import { clampZoom, fitRect, fixedScreenScale, zoomAtPoint } from "../src/canvas-math.js";

test("缩放始终限制在安全范围", () => {
  assert.equal(clampZoom(0.01), 0.2);
  assert.equal(clampZoom(12), 4);
  assert.equal(clampZoom(Number.NaN), 1);
});

test("以指针为中心缩放时世界坐标保持不变", () => {
  const before = { x: 40, y: 20, scale: 1 };
  const pointer = { x: 240, y: 170 };
  const after = zoomAtPoint(before, pointer, 2);
  assert.deepEqual(after, { x: -160, y: -130, scale: 2 });
});

test("画布角色标签使用反向缩放保持屏幕尺寸不变", () => {
  assert.equal(fixedScreenScale(0.25) * 0.25, 1);
  assert.equal(fixedScreenScale(2) * 2, 1);
});

test("适配画布会居中目标矩形", () => {
  const fitted = fitRect({ width: 1200, height: 800 }, { x: 100, y: 50, width: 800, height: 500 }, 100);
  assert.equal(fitted.scale, 1.2);
  assert.equal(fitted.x, 0);
  assert.equal(fitted.y, 40);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  annotationBounds,
  annotationIntersectsRect,
  normalizeRectangle,
  scaleAnnotation
} from "../src/annotation-model.js";

test("反向拖出的矩形归一化为正尺寸", () => {
  const normalized = normalizeRectangle({
    id: "annotation_rect",
    type: "rectangle",
    x: 200,
    y: 180,
    color: "#b9472e",
    width: -80,
    height: -60
  });
  assert.deepEqual(
    { x: normalized.x, y: normalized.y, width: normalized.width, height: normalized.height },
    { x: 120, y: 120, width: 80, height: 60 }
  );
});

test("批注缩放只改变批注几何数据", () => {
  const arrow = scaleAnnotation({
    id: "annotation_arrow",
    type: "arrow",
    x: 20,
    y: 30,
    color: "#b9472e",
    points: [0, 0, 100, 50]
  }, 2, 3);
  assert.deepEqual(arrow, {
    id: "annotation_arrow",
    type: "arrow",
    x: 20,
    y: 30,
    color: "#b9472e",
    points: [0, 0, 200, 150]
  });
});

test("只将与目标图片相交的批注合成到任务附件", () => {
  const inside = {
    id: "annotation_inside",
    type: "rectangle",
    x: 120,
    y: 80,
    width: 160,
    height: 90,
    color: "#7a1820"
  } as const;
  const outside = { ...inside, id: "annotation_outside" as const, x: 900 };
  assert.deepEqual(annotationBounds(inside), { x: 120, y: 80, width: 160, height: 90 });
  assert.equal(annotationIntersectsRect(inside, { x: 100, y: 50, width: 640, height: 427 }), true);
  assert.equal(annotationIntersectsRect(outside, { x: 100, y: 50, width: 640, height: 427 }), false);
});

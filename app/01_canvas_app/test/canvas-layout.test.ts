import assert from "node:assert/strict";
import test from "node:test";
import {
  applyOutputRatio,
  arrangeHorizontally,
  buildCanvasRelation,
  coverCrop,
  coverCropForRenderedImage,
  fitImportedImage,
  normalizeImageFrames,
  placeChildToRight,
  removeImageNode,
  type ImageNodeState
} from "../src/canvas-layout.js";

const baseNode: ImageNodeState = {
  id: "node_test",
  assetId: "asset_test",
  originalRelativePath: "assets/originals/asset_test.png",
  versionId: "version_test",
  origin: "imported",
  parentVersionId: null,
  taskId: null,
  name: "厂房.png",
  src: "data:image/png;base64,AA==",
  sourceWidth: 1600,
  sourceHeight: 900,
  x: 0,
  y: 0,
  width: 640,
  height: 360,
  outputRatio: "free"
};

test("导入大图按边界等比缩小且不放大小图", () => {
  assert.deepEqual(fitImportedImage(4000, 2000), { width: 640, height: 320 });
  assert.deepEqual(fitImportedImage(320, 180), { width: 320, height: 180 });
});

test("输出比例只改变图片框，不改变源图尺寸", () => {
  const square = applyOutputRatio(baseNode, "1:1");
  assert.equal(square.width, 640);
  assert.equal(square.height, 640);
  assert.equal(square.sourceWidth, 1600);
  assert.equal(square.sourceHeight, 900);
});

test("横向排布保持节点顺序并使用实际宽度推进", () => {
  const arranged = arrangeHorizontally([baseNode, { ...baseNode, id: "node_second", width: 320 }], { x: 100, y: 80 }, 40);
  assert.deepEqual(arranged.map(({ x, y }) => ({ x, y })), [{ x: 100, y: 80 }, { x: 780, y: 80 }]);
});

test("整理只统一选中图片的高度并按各自原始比例计算宽度", () => {
  const second = {
    ...baseNode,
    id: "node_second" as const,
    sourceWidth: 1200,
    sourceHeight: 1200,
    width: 480,
    height: 320,
    outputRatio: "3:2" as const
  };
  const normalized = normalizeImageFrames([baseNode, second], second.id);
  assert.equal(normalized[0]?.height, 320);
  assert.equal(normalized[0]?.width, 320 * 1600 / 900);
  assert.equal(normalized[0]?.outputRatio, "free");
  assert.equal(normalized[1]?.height, 320);
  assert.equal(normalized[1]?.width, 320);
  assert.equal(normalized[1]?.outputRatio, "free");
  assert.deepEqual(normalized.map(({ x, y }) => ({ x, y })), [{ x: 0, y: 0 }, { x: 0, y: 0 }]);
  assert.deepEqual(
    coverCrop(
      { width: normalized[0]!.sourceWidth, height: normalized[0]!.sourceHeight },
      { width: normalized[0]!.width, height: normalized[0]!.height }
    ),
    { x: 0, y: 0, width: 1600, height: 900 }
  );
});

test("删除图片节点时保留原数据并解除子节点的父版本引用", () => {
  const child = {
    ...baseNode,
    id: "node_child" as const,
    versionId: "version_child" as const,
    parentVersionId: baseNode.versionId
  };
  const remaining = removeImageNode([baseNode, child], baseNode.id);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.id, child.id);
  assert.equal(remaining[0]?.parentVersionId, null);
});

test("图片框裁切采用居中 cover 且不改变源图", () => {
  assert.deepEqual(coverCrop({ width: 1600, height: 900 }, { width: 640, height: 640 }), {
    x: 350,
    y: 0,
    width: 900,
    height: 900
  });
});

test("生成图显示副本尺寸与原图元数据不同时按实际解码尺寸裁切", () => {
  const crop = coverCropForRenderedImage(
    { width: 1280, height: 853 },
    { width: 1536, height: 1024 },
    { width: 640, height: 427 }
  );
  assert.ok(crop.x >= 0);
  assert.ok(crop.y >= 0);
  assert.ok(crop.width <= 1280);
  assert.ok(crop.height <= 853);
});

test("生成结果固定放到父节点右侧并记录父版本", () => {
  const child = placeChildToRight(
    { ...baseNode, x: 180, y: 120, width: 640 },
    {
      ...baseNode,
      id: "node_child",
      versionId: "version_child",
      origin: "generated",
      taskId: "task_demo"
    },
    96
  );
  assert.equal(child.x, 916);
  assert.equal(child.y, 120);
  assert.equal(child.parentVersionId, "version_test");
  assert.equal(child.taskId, "task_demo");
});

test("父子图片上下排布时连线从下边指向上边", () => {
  const relation = buildCanvasRelation(
    { x: 100, y: 80, width: 320, height: 220 },
    { x: 140, y: 520, width: 320, height: 220 }
  );
  assert.equal(relation.axis, "vertical");
  assert.deepEqual(relation.points.slice(0, 2), [260, 308]);
  assert.deepEqual(relation.points.slice(-2), [300, 512]);
});

test("父子图片左右排布时连线仍连接相邻侧边", () => {
  const relation = buildCanvasRelation(
    { x: 100, y: 80, width: 320, height: 220 },
    { x: 620, y: 120, width: 320, height: 220 }
  );
  assert.equal(relation.axis, "horizontal");
  assert.deepEqual(relation.points.slice(0, 2), [428, 190]);
  assert.deepEqual(relation.points.slice(-2), [612, 230]);
});

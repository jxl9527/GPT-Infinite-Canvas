import assert from "node:assert/strict";
import test from "node:test";
import {
  applyOutputRatio,
  arrangeHorizontally,
  arrangeVertically,
  buildCanvasRelation,
  coverCrop,
  coverCropForRenderedImage,
  fitImportedImage,
  normalizeImageFrames,
  nextChildBoundsToRight,
  placeChildToRight,
  placeChildToRightStacked,
  placeImageContextToolbar,
  removeImageNode,
  removeImageNodes,
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

test("批量删除全部已选图片并解除剩余子节点的父版本引用", () => {
  const child = {
    ...baseNode,
    id: "node_child" as const,
    versionId: "version_child" as const,
    parentVersionId: baseNode.versionId
  };
  const grandchild = {
    ...baseNode,
    id: "node_grandchild" as const,
    versionId: "version_grandchild" as const,
    parentVersionId: child.versionId
  };
  const sibling = {
    ...baseNode,
    id: "node_sibling" as const,
    versionId: "version_sibling" as const,
    parentVersionId: null
  };
  const remaining = removeImageNodes(
    [baseNode, child, grandchild, sibling],
    [baseNode.id, child.id]
  );
  assert.deepEqual(remaining.map((node) => node.id), [grandchild.id, sibling.id]);
  assert.equal(remaining[0]?.parentVersionId, null);
  assert.equal(remaining[1]?.parentVersionId, null);
});

test("同源生成结果在父图右侧纵向排队且不覆盖已有结果", () => {
  const parent = { ...baseNode, x: 180, y: 120, width: 640, height: 360 };
  const first = placeChildToRightStacked(parent, {
    ...baseNode,
    id: "node_first",
    versionId: "version_first",
    origin: "generated",
    taskId: "task_first"
  });
  const second = placeChildToRightStacked(parent, {
    ...baseNode,
    id: "node_second",
    versionId: "version_second",
    origin: "generated",
    taskId: "task_second"
  }, [first]);
  assert.deepEqual({ x: first.x, y: first.y }, { x: 916, y: 120 });
  assert.deepEqual({ x: second.x, y: second.y }, { x: 916, y: 528 });
  assert.ok(first.y + first.height < second.y);
  assert.deepEqual(
    nextChildBoundsToRight(parent, parent, [first, second]),
    { x: 916, y: 936, width: 640, height: 360 }
  );
});

test("纵向排布使用每张图片实际高度推进且不会重叠", () => {
  const first = { ...baseNode, id: "node_first" as const, width: 640, height: 320 };
  const second = { ...baseNode, id: "node_second" as const, width: 480, height: 440 };
  const third = { ...baseNode, id: "node_third" as const, width: 600, height: 300 };
  const arranged = arrangeVertically([first, second, third], { x: 180, y: 90 }, 96);
  assert.deepEqual(arranged.map((node) => ({ x: node.x, y: node.y })), [
    { x: 180, y: 90 },
    { x: 180, y: 506 },
    { x: 180, y: 1042 }
  ]);
  assert.ok(arranged[0]!.y + arranged[0]!.height < arranged[1]!.y);
  assert.ok(arranged[1]!.y + arranged[1]!.height < arranged[2]!.y);
});

test("图片浮动工具栏优先放在图片上方并限制在画布范围内", () => {
  const placement = placeImageContextToolbar(
    { x: 200, y: 180, width: 640, height: 360 },
    { x: 40, y: 30, scale: 0.75 },
    { width: 960, height: 720 }
  );
  assert.deepEqual(placement, {
    left: 200,
    top: 101,
    width: 460,
    placement: "above"
  });
});

test("图片贴近画布顶部时工具栏移到下方，图片不可见时不显示", () => {
  const below = placeImageContextToolbar(
    { x: 40, y: 10, width: 320, height: 180 },
    { x: 0, y: 0, scale: 1 },
    { width: 640, height: 480 }
  );
  assert.equal(below?.placement, "below");
  assert.equal(below?.top, 200);
  assert.equal(
    placeImageContextToolbar(
      { x: 900, y: 20, width: 320, height: 180 },
      { x: 0, y: 0, scale: 1 },
      { width: 640, height: 480 }
    ),
    null
  );
});

test("窄窗口图片工具栏避开左侧固定工具轨", () => {
  const placement = placeImageContextToolbar(
    { x: 0, y: 200, width: 640, height: 360 },
    { x: 0, y: 0, scale: 1 },
    { width: 720, height: 600 },
    { minWidth: 620, maxWidth: 760, height: 62, leftInset: 76 }
  );
  assert.equal(placement?.left, 76);
  assert.equal(placement?.width, 632);
  assert.ok((placement?.left ?? 0) >= 76);
  assert.ok((placement?.left ?? 0) + (placement?.width ?? 0) <= 708);
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

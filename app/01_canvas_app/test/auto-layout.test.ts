import assert from "node:assert/strict";
import test from "node:test";
import { autoArrangeCanvasObjects } from "../src/auto-layout.js";
import type { ImageNodeState } from "../src/canvas-layout.js";
import type { CanvasTextCard } from "../src/text-card.js";

function image(
  id: string,
  versionId: string,
  x: number,
  y: number,
  width = 640,
  height = 360,
  parentVersionId: ImageNodeState["parentVersionId"] = null
): ImageNodeState {
  return {
    id: `node_${id}`,
    assetId: `asset_${id}`,
    originalRelativePath: `assets/originals/asset_${id}.png`,
    versionId: `version_${versionId}`,
    origin: parentVersionId ? "generated" : "imported",
    parentVersionId,
    taskId: null,
    name: `${id}.png`,
    src: "data:image/png;base64,AA==",
    sourceWidth: width,
    sourceHeight: height,
    x,
    y,
    width,
    height,
    outputRatio: "free"
  };
}

function card(id: string, sourceVersionId: CanvasTextCard["sourceVersionId"], x: number, y: number): CanvasTextCard {
  return {
    id: `text_card_${id}`,
    kind: "review",
    title: id,
    text: "审查结论",
    x,
    y,
    width: 460,
    height: 360,
    sourceVersionId,
    taskId: `task_${id}`,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z"
  };
}

function overlaps(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number }
): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

test("自动排版按文字卡在左、来源图居中、生成图在右分列，且所有对象互不遮挡", () => {
  const rootA = image("root_a", "root_a", 360, 180);
  const childA1 = image("child_a1", "child_a1", 380, 200, 640, 360, rootA.versionId);
  const childA2 = image("child_a2", "child_a2", 400, 220, 480, 320, rootA.versionId);
  const rootB = image("root_b", "root_b", 420, 240, 600, 340);
  const reviewA = card("review_a", rootA.versionId, 340, 160);
  const reviewB = card("review_b", rootB.versionId, 360, 200);

  const result = autoArrangeCanvasObjects(
    [rootA, childA1, childA2, rootB],
    [reviewA, reviewB]
  );
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  const cardsById = new Map(result.textCards.map((item) => [item.id, item]));
  const nextRootA = byId.get(rootA.id)!;
  const nextChildA1 = byId.get(childA1.id)!;
  const nextChildA2 = byId.get(childA2.id)!;
  const nextRootB = byId.get(rootB.id)!;
  const nextReviewA = cardsById.get(reviewA.id)!;

  assert.equal(nextReviewA.x, result.bounds.x);
  assert.equal(nextRootA.x, nextReviewA.x + reviewA.width + 120);
  assert.equal(nextChildA1.x, nextRootA.x + 640 + 120);
  assert.equal(nextChildA2.x, nextChildA1.x);
  assert.equal(nextChildA2.y, nextChildA1.y + nextChildA1.height + 64);
  assert.ok(nextRootB.y >= nextChildA2.y + nextChildA2.height + 160);

  for (const original of [rootA, childA1, childA2, rootB]) {
    const arranged = byId.get(original.id)!;
    assert.deepEqual(
      { width: arranged.width, height: arranged.height, sourceWidth: arranged.sourceWidth, sourceHeight: arranged.sourceHeight },
      { width: original.width, height: original.height, sourceWidth: original.sourceWidth, sourceHeight: original.sourceHeight }
    );
  }

  const rectangles = [...result.nodes, ...result.textCards];
  rectangles.forEach((rectangle, index) => {
    rectangles.slice(index + 1).forEach((other) => assert.equal(overlaps(rectangle, other), false));
  });
});

test("局部自动排版只移动框选对象，并避开未选中的画布对象", () => {
  const obstacle = image("obstacle", "obstacle", 120, 120);
  const root = image("selected_root", "selected_root", 120, 120);
  const child = image("selected_child", "selected_child", 140, 140, 480, 320, root.versionId);
  const untouchedCard = card("untouched", obstacle.versionId, 1_900, 120);

  const result = autoArrangeCanvasObjects(
    [obstacle, root, child],
    [untouchedCard],
    { nodeIds: [root.id, child.id], textCardIds: [] }
  );
  const byId = new Map(result.nodes.map((node) => [node.id, node]));

  assert.deepEqual(byId.get(obstacle.id), obstacle);
  assert.deepEqual(result.textCards[0], untouchedCard);
  assert.ok(byId.get(root.id)!.y >= obstacle.y + obstacle.height + 24);
  assert.equal(overlaps(byId.get(root.id)!, obstacle), false);
  assert.equal(overlaps(byId.get(child.id)!, obstacle), false);
});

test("自动排版为生成中占位框预留下一候选位置", () => {
  const rootA = image("root_a", "root_a", 200, 120, 640, 360);
  const childA = image("child_a", "child_a", 900, 120, 640, 360, rootA.versionId);
  const rootB = image("root_b", "root_b", 200, 500, 640, 360);

  const result = autoArrangeCanvasObjects(
    [rootA, childA, rootB],
    [],
    { reservations: [{ sourceVersionId: rootA.versionId, width: 640, height: 360 }] }
  );
  const byId = new Map(result.nodes.map((node) => [node.id, node]));

  assert.ok(byId.get(rootB.id)!.y >= byId.get(childA.id)!.y + childA.height + 64 + 360 + 160);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCanvasNodeIndex,
  selectedNodesInCanvasOrder
} from "../src/canvas-node-index.js";
import type { ImageNodeState } from "../src/canvas-layout.js";

function imageNode(index: number, parentVersionId: ImageNodeState["parentVersionId"] = null): ImageNodeState {
  return {
    id: `node_${index}`,
    assetId: `asset_${index}`,
    originalRelativePath: `assets/originals/asset_${index}.png`,
    versionId: `version_${index}`,
    origin: parentVersionId ? "generated" : "imported",
    parentVersionId,
    taskId: null,
    name: `视角 ${index}.png`,
    src: "data:image/png;base64,AA==",
    sourceWidth: 1600,
    sourceHeight: 900,
    x: index * 20,
    y: 0,
    width: 640,
    height: 360,
    outputRatio: "free"
  };
}

test("节点索引同时支持画布 id、版本 id 与父子关系查询", () => {
  const nodes = [imageNode(0), imageNode(1, "version_0"), imageNode(2, "version_0")];
  const index = buildCanvasNodeIndex(nodes);

  assert.equal(index.byId.get("node_1"), nodes[1]);
  assert.equal(index.byVersionId.get("version_2"), nodes[2]);
  assert.deepEqual(index.childrenByParentVersionId.get("version_0"), [nodes[1], nodes[2]]);
  assert.equal(index.childrenByParentVersionId.has("version_missing"), false);
});

test("批量选择始终保持画布顺序且忽略失效 id", () => {
  const nodes = [imageNode(0), imageNode(1), imageNode(2)];
  assert.deepEqual(
    selectedNodesInCanvasOrder(nodes, ["node_2", "node_missing", "node_0"]),
    [nodes[0], nodes[2]]
  );
});

test("大项目索引不会遗漏末尾节点和跨段父子关系", () => {
  const nodes = Array.from({ length: 12_000 }, (_, index) => imageNode(
    index,
    index > 0 && index % 200 === 0 ? `version_${index - 200}` : null
  ));
  const index = buildCanvasNodeIndex(nodes);

  assert.equal(index.byId.size, 12_000);
  assert.equal(index.byVersionId.get("version_11999"), nodes[11_999]);
  assert.deepEqual(index.childrenByParentVersionId.get("version_0"), [nodes[200]]);
});

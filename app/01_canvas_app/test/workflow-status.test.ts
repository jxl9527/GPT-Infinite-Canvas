import assert from "node:assert/strict";
import test from "node:test";
import type { ImageNodeState } from "../src/canvas-layout.js";
import type { ViewpointStatusCard } from "../src/project-state.js";
import { inferViewpointStatus } from "../src/workflow-status.js";

const source: ImageNodeState = {
  id: "node_source",
  assetId: "asset_source",
  originalRelativePath: "assets/originals/source.png",
  versionId: "version_source",
  origin: "imported",
  parentVersionId: null,
  taskId: null,
  name: "1人视.png",
  src: "data:image/png;base64,AA==",
  sourceWidth: 1600,
  sourceHeight: 1000,
  x: 0,
  y: 0,
  width: 800,
  height: 500,
  outputRatio: "free"
};

const viewpoint: ViewpointStatusCard = {
  id: "viewpoint_test",
  name: "1人视",
  purpose: "主入口投标主图",
  stage: "stage-1",
  status: "not-started",
  statusMode: "auto",
  d5Batch: "D5_01",
  sourceVersionId: source.versionId,
  selectedVersionId: null,
  conclusion: "",
  nextAction: "",
  updatedAt: "2026-08-03T00:00:00.000Z"
};

test("自动状态以可验证的版本关系判断，不猜测主观返工结论", () => {
  assert.equal(inferViewpointStatus(viewpoint, [source], null, null).status, "not-started");

  const candidate: ImageNodeState = {
    ...source,
    id: "node_candidate",
    assetId: "asset_candidate",
    versionId: "version_candidate",
    origin: "generated",
    parentVersionId: source.versionId,
    taskId: "task_candidate",
    name: "1人视_01.png"
  };
  assert.equal(inferViewpointStatus(viewpoint, [source, candidate], null, null).status, "in-progress");
  assert.equal(
    inferViewpointStatus({ ...viewpoint, selectedVersionId: candidate.versionId }, [source, candidate], null, null).status,
    "locked"
  );
});

test("缺少底图自动标记缺少素材，人工覆盖优先于自动判断", () => {
  assert.equal(
    inferViewpointStatus({ ...viewpoint, sourceVersionId: null }, [source], null, null).status,
    "blocked"
  );
  const manual = inferViewpointStatus({
    ...viewpoint,
    statusMode: "manual",
    status: "rework"
  }, [source], null, null);
  assert.equal(manual.status, "rework");
  assert.equal(manual.mode, "manual");
});

import assert from "node:assert/strict";
import test from "node:test";
import { createViewpointStatusCard } from "../src/project-state.js";
import {
  businessCanvasNodeLabel,
  buildViewpointTaskSummaries,
  candidateReviewComplete,
  createCandidateReviewRecord,
  filterViewpointTasks,
  updateCandidateReviewRecord
} from "../src/viewpoint-task-center.js";

const sourceVersionId = "version_00000000-0000-0000-0000-000000000101" as const;
const candidateOne = "version_00000000-0000-0000-0000-000000000102" as const;
const candidateTwo = "version_00000000-0000-0000-0000-000000000103" as const;

test("视角任务中心以业务名称汇总候选、风险和采用状态", () => {
  const viewpoint = createViewpointStatusCard({ name: "1人视", stage: "scene-optimization", sourceVersionId });
  viewpoint.sceneOptimization.candidateVersionIds = [candidateOne, candidateTwo];
  viewpoint.candidateReviews = updateCandidateReviewRecord([], candidateOne, "scene-optimization", (review) => ({
    ...review,
    checks: { ...review.checks, structure: "failed" },
    decision: "rejected",
    note: "幕墙分格漂移"
  }));
  const nodes = [
    { versionId: sourceVersionId, id: "node_source", name: "1人视_D5.png" },
    { versionId: candidateOne, id: "node_candidate_1", name: "result_123.png" },
    { versionId: candidateTwo, id: "node_candidate_2", name: "result_456.png" }
  ] as never[];
  const [summary] = buildViewpointTaskSummaries([viewpoint], nodes, null);
  assert.equal(summary.state, "attention");
  assert.equal(summary.riskCount, 1);
  assert.equal(summary.candidates[0].displayName, "1人视 · 场景候选 01");
  assert.equal(summary.candidates[0].riskMessage, "幕墙分格漂移");
  assert.equal(filterViewpointTasks([summary], "attention", "幕墙").length, 1);
});

test("候选五项全部通过后才允许形成完整验收", () => {
  let review = createCandidateReviewRecord(candidateTwo, "scene-optimization");
  assert.equal(candidateReviewComplete(review), false);
  for (const key of Object.keys(review.checks) as Array<keyof typeof review.checks>) {
    review = { ...review, checks: { ...review.checks, [key]: "passed" } };
  }
  assert.equal(candidateReviewComplete(review), true);
});

test("画布对象导航优先显示视角业务名称而不是结果文件名", () => {
  const viewpoint = createViewpointStatusCard({ name: "东南人视", stage: "scene-optimization", sourceVersionId });
  viewpoint.sceneOptimization.candidateVersionIds = [candidateOne];
  const nodes = [
    { versionId: sourceVersionId, id: "node_source", name: "20260813121212.png", origin: "imported" },
    { versionId: candidateOne, id: "node_candidate", name: "result_00000000-0000.png", origin: "generated" }
  ] as never[];
  const tasks = buildViewpointTaskSummaries([viewpoint], nodes, null);
  assert.equal(businessCanvasNodeLabel(nodes[0], tasks, 0), "东南人视 · 阶段底图");
  assert.equal(businessCanvasNodeLabel(nodes[1], tasks, 1), "东南人视 · 场景候选 01");
});

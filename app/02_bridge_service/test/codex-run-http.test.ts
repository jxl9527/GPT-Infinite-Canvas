import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ProjectRuntimeManager } from "../src/project-runtime-manager.js";
import { createBridgeServer } from "../src/server.js";

const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL3SAAAAABJRU5ErkJggg==";
const pngVariant = (marker: number) => {
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  return `data:image/png;base64,${Buffer.concat([bytes, Buffer.from([marker])]).toString("base64")}`;
};

test("Codex 领域接口要求授权、支持幂等左置文字卡与安全暂停恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-canvas-codex-run-"));
  const projects = new ProjectRuntimeManager(join(root, ".runtime"), root);
  await projects.init();
  const activeWorkbenchProject = await projects.create("Codex 主项目", undefined);
  const secondaryWorkbenchProject = await projects.create("Codex 备用项目", undefined);
  await projects.activate(activeWorkbenchProject.id);
  const token = "codex-run-token";
  const server = createBridgeServer({ projects, token, allowedOrigins: [], canvasOrigins: [] });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "content-type": "application/json", "x-bridge-token": token };
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    return { response, json: await response.json() as Record<string, unknown> };
  };

  try {
    const capabilitiesResponse = await fetch(`${base}/api/v1/canvas/codex-capabilities`, { headers });
    assert.equal(capabilitiesResponse.status, 200);
    const capabilities = await capabilitiesResponse.json() as { capabilities: { automaticFinalSelection: boolean; arbitraryFileWrite: boolean } };
    assert.equal(capabilities.capabilities.automaticFinalSelection, false);
    assert.equal(capabilities.capabilities.arbitraryFileWrite, false);

    const imported = await post("/api/v1/canvas/assets", { name: "1人视.png", dataUrl });
    assert.equal(imported.response.status, 201);
    const asset = imported.json.asset as Record<string, unknown>;
    const versionId = "version_00000000-0000-0000-0000-000000000901";
    const secondVersionId = "version_00000000-0000-0000-0000-000000000902";
    const now = new Date().toISOString();
    const project = {
      schemaVersion: "2.0",
      projectId: "project_00000000-0000-0000-0000-000000000901",
      title: "Codex 前置检查测试",
      createdAt: now,
      updatedAt: now,
      revision: 1,
      canvas: {
        viewport: { x: 0, y: 0, scale: 1 },
        nodes: [{
          id: "node_00000000-0000-0000-0000-000000000901",
          type: "image",
          x: 800,
          y: 100,
          width: 640,
          height: 427,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: 0,
          locked: false,
          visible: true,
          payload: { imageVersionId: versionId, fit: "cover", name: "1人视.png" }
        }, {
          id: "node_00000000-0000-0000-0000-000000000902",
          type: "image",
          x: 800,
          y: 600,
          width: 640,
          height: 427,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: 1,
          locked: false,
          visible: true,
          payload: { imageVersionId: secondVersionId, fit: "cover", name: "2人视.png" }
        }]
      },
      assets: [asset],
      versions: [
        { id: versionId, assetId: asset.id, origin: "imported", parentVersionId: null, taskId: null, createdAt: now },
        { id: secondVersionId, assetId: asset.id, origin: "imported", parentVersionId: null, taskId: null, createdAt: now }
      ],
      taskLinks: [],
      workflow: {
        activeViewpointId: "viewpoint_codex_01",
        viewpoints: [{
          id: "viewpoint_codex_01",
          name: "1人视",
          purpose: "主入口",
          stage: "preflight",
          status: "in-progress",
          statusMode: "auto",
          d5Batch: "D5_01",
          sourceVersionId: versionId,
          selectedVersionId: null,
          conclusion: "",
          nextAction: "",
          preflight: { d5ViewVersionId: versionId, suReferenceVersionId: null, conclusionCardId: null, status: "pending" },
          sceneOptimization: { structureBaseVersionId: null, styleReferenceVersionId: null, promptCardId: null, candidateVersionIds: [], selectedVersionId: null, status: "not-run" },
          finalGlass: { finalD5VersionId: null, candidateVersionIds: [], selectedVersionIds: [], validation: "pending", status: "not-run" },
          export: { targetDirectory: null, exportedVersionIds: [], exportedFiles: [], exportedAt: null, status: "pending" },
          updatedAt: now
        }, {
          id: "viewpoint_codex_02",
          name: "2人视",
          purpose: "转角",
          stage: "scene-optimization",
          status: "not-started",
          statusMode: "auto",
          d5Batch: "D5_01",
          sourceVersionId: secondVersionId,
          selectedVersionId: null,
          conclusion: "",
          nextAction: "",
          preflight: { d5ViewVersionId: secondVersionId, suReferenceVersionId: null, conclusionCardId: null, status: "pending" },
          sceneOptimization: { structureBaseVersionId: secondVersionId, styleReferenceVersionId: null, promptCardId: null, candidateVersionIds: [], selectedVersionId: null, status: "pending" },
          finalGlass: { finalD5VersionId: null, candidateVersionIds: [], selectedVersionIds: [], validation: "pending", status: "not-run" },
          export: { targetDirectory: null, exportedVersionIds: [], exportedFiles: [], exportedAt: null, status: "pending" },
          updatedAt: now
        }],
        handoffs: [],
        customGptUrl: "",
        customGptEnabled: false,
        textCards: [],
        batchRun: null
      }
    };
    assert.equal((await post("/api/v1/canvas/project", { project })).response.status, 200);

    const denied = await post("/api/v1/canvas/codex-runs", {
      authorizationId: "authorization_test_0001",
      sourceFolder: null,
      stage: "preflight",
      action: "analyze",
      sourceVersionIds: [versionId],
      maximumGenerations: 0,
      allowManualFallback: true,
      stopOnStructureRisk: true,
      confirmed: false
    });
    assert.equal(denied.response.status, 422);

    const created = await post("/api/v1/canvas/codex-runs", {
      authorizationId: "authorization_test_0001",
      sourceFolder: null,
      stage: "preflight",
      action: "analyze",
      sourceVersionIds: [versionId],
      maximumGenerations: 0,
      allowManualFallback: true,
      stopOnStructureRisk: true,
      confirmed: true
    });
    assert.equal(created.response.status, 201);
    const run = created.json.run as { id: string; authorization: { id: string }; items: Array<{ checkpoint: string }> };
    assert.equal(run.authorization.id, "authorization_test_0001");
    assert.equal(run.items[0]?.checkpoint, "manifest-confirmed");

    assert.equal((await post(`/api/v1/canvas/codex-runs/${run.id}/text-cards`, {
      authorizationId: "authorization_test_0001",
      sourceVersionId: versionId,
      kind: "prompt",
      title: "错误类型",
      text: "前置阶段不应接受提示词卡。",
      idempotencyKey: "codex-card-wrong-kind-0001"
    })).response.status, 409);

    assert.equal((await post(`/api/v1/canvas/codex-runs/${run.id}/pause`, {})).response.status, 200);
    assert.equal((await post(`/api/v1/canvas/codex-runs/${run.id}/resume`, { leaseOwner: "codex-test" })).response.status, 200);

    const cardInput = {
      authorizationId: "authorization_test_0001",
      sourceVersionId: versionId,
      kind: "review",
      title: "1人视前置审查",
      text: "【视角结论】可用。\n【修改意见】补充入口雨棚收边，不改变建筑体块与相机。",
      idempotencyKey: "codex-card-test-0001"
    };
    const registered = await post(`/api/v1/canvas/codex-runs/${run.id}/text-cards`, cardInput);
    assert.equal(registered.response.status, 201);
    const card = registered.json.card as { id: string; x: number; sourceVersionId: string };
    assert.equal(card.x, 268);
    assert.equal(card.sourceVersionId, versionId);
    assert.match(String(registered.json.snapshotRelativePath), /^canvas\/snapshots\//);

    const duplicate = await post(`/api/v1/canvas/codex-runs/${run.id}/text-cards`, cardInput);
    assert.equal(duplicate.response.status, 200);
    assert.equal((duplicate.json.card as { id: string }).id, card.id);
    assert.equal(duplicate.json.deduplicated, true);

    const restored = await fetch(`${base}/api/v1/canvas/project`, { headers }).then((response) => response.json()) as {
      project: { workflow: { textCards: unknown[]; viewpoints: Array<{ preflight: { status: string; conclusionCardId: string } }>; batchRun: { status: string } } }
    };
    assert.equal(restored.project.workflow.textCards.length, 1);
    assert.equal(restored.project.workflow.viewpoints[0]?.preflight.status, "completed");
    assert.equal(restored.project.workflow.viewpoints[0]?.preflight.conclusionCardId, card.id);
    assert.equal(restored.project.workflow.batchRun.status, "completed");

    assert.equal((await post("/api/v1/canvas/codex-runs", {
      authorizationId: "authorization_test_prompt_only",
      sourceFolder: null,
      stage: "scene-optimization",
      action: "prompt",
      sourceVersionIds: [versionId],
      maximumGenerations: 0,
      allowManualFallback: true,
      stopOnStructureRisk: true,
      confirmed: true
    })).response.status, 422);

    const generationRunCall = await post("/api/v1/canvas/codex-runs", {
      authorizationId: "authorization_test_0002",
      sourceFolder: null,
      stage: "scene-optimization",
      action: "generate",
      sourceVersionIds: [versionId],
      maximumGenerations: 1,
      allowManualFallback: true,
      stopOnStructureRisk: true,
      confirmed: true
    });
    assert.equal(generationRunCall.response.status, 201);
    assert.equal((await post(`/api/v1/workbench/projects/${secondaryWorkbenchProject.id}/activate`, {})).response.status, 409);
    assert.equal((await post(`/api/v1/workbench/projects/${activeWorkbenchProject.id}/delete`, {})).response.status, 409);
    const generationRun = generationRunCall.json.run as { id: string; items: Array<{ id: string }> };
    const generationItemId = generationRun.items[0]!.id;
    const promptRegistered = await post(`/api/v1/canvas/codex-runs/${generationRun.id}/text-cards`, {
      authorizationId: "authorization_test_0002",
      sourceVersionId: versionId,
      kind: "prompt",
      title: "1人视场景优化提示词",
      text: "保持原始建筑体块、相机和道路关系，仅优化材质、光影与环境表达。",
      idempotencyKey: "codex-prompt-test-0002"
    });
    assert.equal(promptRegistered.response.status, 201);
    assert.equal((promptRegistered.json.run as { status: string }).status, "running");
    assert.equal((promptRegistered.json.run as { items: Array<{ status: string; checkpoint: string }> }).items[0]?.status, "queued");
    assert.equal((promptRegistered.json.run as { items: Array<{ status: string; checkpoint: string }> }).items[0]?.checkpoint, "prompt-approved");

    const inputs = await fetch(`${base}/api/v1/canvas/codex-runs/${generationRun.id}/items/${generationItemId}/inputs`, { headers });
    assert.equal(inputs.status, 200);
    const inputPayload = await inputs.json() as { item: { prompt: string; inputs: Array<{ absolutePath: string; role: string }> } };
    assert.match(inputPayload.item.prompt, /保持原始建筑体块/);
    assert.equal(inputPayload.item.inputs.length, 1);
    assert.equal(inputPayload.item.inputs[0]?.role, "structure-base");
    assert.match(inputPayload.item.inputs[0]?.absolutePath ?? "", /assets[\\/]originals/);

    const submitted = await post(`/api/v1/canvas/codex-runs/${generationRun.id}/items/${generationItemId}/generation-submitted`, {
      authorizationId: "authorization_test_0002",
      leaseOwner: "codex-test-run",
      confirmed: true
    });
    assert.equal(submitted.response.status, 201);
    assert.equal((submitted.json.item as { checkpoint: string }).checkpoint, "generation-submitted");
    assert.equal((await post(`/api/v1/canvas/codex-runs/${generationRun.id}/items/${generationItemId}/generation-submitted`, {
      authorizationId: "authorization_test_0002",
      leaseOwner: "wrong-runner",
      confirmed: true
    })).response.status, 409);
    const submitDuplicate = await post(`/api/v1/canvas/codex-runs/${generationRun.id}/items/${generationItemId}/generation-submitted`, {
      authorizationId: "authorization_test_0002",
      leaseOwner: "codex-test-run",
      confirmed: true
    });
    assert.equal(submitDuplicate.response.status, 200);
    assert.equal(submitDuplicate.json.deduplicated, true);

    const generated = await post("/api/v1/canvas/generated-assets", { name: "1人视_参考效果.png", dataUrl });
    assert.equal(generated.response.status, 201);
    const generatedAsset = generated.json.asset as { id: string };
    const changedPromptProject = await fetch(`${base}/api/v1/canvas/project`, { headers })
      .then((response) => response.json()) as { project: Record<string, any> };
    const promptCardId = (promptRegistered.json.card as { id: string }).id;
    const changedPromptCard = changedPromptProject.project.workflow.textCards
      .find((candidate: Record<string, unknown>) => candidate.id === promptCardId);
    const approvedPromptText = changedPromptCard.text;
    changedPromptCard.text = `${approvedPromptText}\n临时变化`;
    changedPromptProject.project.revision += 1;
    changedPromptProject.project.updatedAt = new Date().toISOString();
    assert.equal((await post("/api/v1/canvas/project", { project: changedPromptProject.project })).response.status, 200);
    assert.equal((await post(`/api/v1/canvas/codex-runs/${generationRun.id}/items/${generationItemId}/generated-results`, {
      authorizationId: "authorization_test_0002",
      leaseOwner: "codex-test-run",
      assetId: generatedAsset.id,
      structureRisk: "none",
      confirmed: true
    })).response.status, 409);
    changedPromptCard.text = approvedPromptText;
    changedPromptProject.project.revision += 1;
    changedPromptProject.project.updatedAt = new Date().toISOString();
    assert.equal((await post("/api/v1/canvas/project", { project: changedPromptProject.project })).response.status, 200);
    assert.equal((await post(`/api/v1/canvas/codex-runs/${generationRun.id}/items/${generationItemId}/generated-results`, {
      authorizationId: "authorization_test_0002",
      leaseOwner: "wrong-runner",
      assetId: generatedAsset.id,
      structureRisk: "none",
      confirmed: true
    })).response.status, 409);
    const resultCall = await post(`/api/v1/canvas/codex-runs/${generationRun.id}/items/${generationItemId}/generated-results`, {
      authorizationId: "authorization_test_0002",
      leaseOwner: "codex-test-run",
      assetId: generatedAsset.id,
      structureRisk: "none",
      confirmed: true
    });
    assert.equal(resultCall.response.status, 201);
    assert.equal((resultCall.json.validation as { passed: boolean }).passed, true);
    assert.equal((resultCall.json.item as { checkpoint: string }).checkpoint, "validation-completed");
    const generatedVersionId = String(resultCall.json.versionId);
    assert.match(generatedVersionId, /^version_/);

    const resultDuplicate = await post(`/api/v1/canvas/codex-runs/${generationRun.id}/items/${generationItemId}/generated-results`, {
      authorizationId: "authorization_test_0002",
      leaseOwner: "another-runner-is-ignored-for-terminal-dedup",
      assetId: generatedAsset.id,
      structureRisk: "none",
      confirmed: true
    });
    assert.equal(resultDuplicate.response.status, 200);
    assert.equal(resultDuplicate.json.deduplicated, true);
    assert.equal(resultDuplicate.json.versionId, generatedVersionId);

    const afterGeneration = await fetch(`${base}/api/v1/canvas/project`, { headers }).then((response) => response.json()) as {
      project: { canvas: { nodes: Array<{ x: number; payload: { imageVersionId: string } }> }; versions: Array<{ id: string; parentVersionId: string | null }>; workflow: { batchRun: { status: string }; viewpoints: Array<{ sceneOptimization: { candidateVersionIds: string[]; selectedVersionId: string | null } }> } }
    };
    const resultNode = afterGeneration.project.canvas.nodes.find((node) => node.payload.imageVersionId === generatedVersionId);
    assert.equal(resultNode?.x, 1512);
    assert.equal(afterGeneration.project.versions.find((version) => version.id === generatedVersionId)?.parentVersionId, versionId);
    assert.deepEqual(afterGeneration.project.workflow.viewpoints[0]?.sceneOptimization.candidateVersionIds, [generatedVersionId]);
    assert.equal(afterGeneration.project.workflow.viewpoints[0]?.sceneOptimization.selectedVersionId, null);
    assert.equal(afterGeneration.project.workflow.batchRun.status, "completed");

    const retryRunCall = await post("/api/v1/canvas/codex-runs", {
      authorizationId: "authorization_test_retry",
      sourceFolder: null,
      stage: "scene-optimization",
      action: "generate",
      sourceVersionIds: [versionId, secondVersionId],
      maximumGenerations: 4,
      allowManualFallback: true,
      stopOnStructureRisk: true,
      confirmed: true
    });
    assert.equal(retryRunCall.response.status, 201);
    const retryRun = retryRunCall.json.run as { id: string; items: Array<{ id: string }> };
    const [retryItem, nextItem] = retryRun.items;
    assert.ok(retryItem && nextItem);
    assert.equal((await post(`/api/v1/canvas/codex-runs/${retryRun.id}/text-cards`, {
      authorizationId: "authorization_test_retry",
      sourceVersionId: versionId,
      kind: "prompt",
      title: "1人视结构锁定提示词",
      text: "把底图作为像素对齐编辑基准，不重绘结构，只优化材质和光影。",
      idempotencyKey: "codex-prompt-test-retry-01"
    })).response.status, 201);

    assert.equal((await post(`/api/v1/canvas/codex-runs/${retryRun.id}/items/${retryItem.id}/generation-submitted`, {
      authorizationId: "authorization_test_retry",
      leaseOwner: "codex-test-retry",
      confirmed: true
    })).response.status, 201);
    const rejectedAssetOne = (await post("/api/v1/canvas/generated-assets", { name: "1人视_风险候选_01.png", dataUrl: pngVariant(1) })).json.asset as { id: string };
    const rejectedOne = await post(`/api/v1/canvas/codex-runs/${retryRun.id}/items/${retryItem.id}/generated-results`, {
      authorizationId: "authorization_test_retry",
      leaseOwner: "codex-test-retry",
      assetId: rejectedAssetOne.id,
      structureRisk: "suspected",
      confirmed: true
    });
    assert.equal(rejectedOne.response.status, 201);
    assert.deepEqual(rejectedOne.json.validation, {
      passed: false,
      ratioMatches: true,
      dimensionsMatch: true,
      structureRisk: "suspected",
      reasons: ["结构风险：suspected"],
      retryScheduled: true,
      itemGenerationBudget: 2,
      itemAttemptsUsed: 1
    });
    assert.equal((rejectedOne.json.run as { status: string }).status, "running");
    assert.equal((rejectedOne.json.item as { status: string; checkpoint: string }).status, "queued");
    assert.equal((rejectedOne.json.item as { status: string; checkpoint: string }).checkpoint, "prompt-approved");

    assert.equal((await post(`/api/v1/canvas/codex-runs/${retryRun.id}/items/${retryItem.id}/generation-submitted`, {
      authorizationId: "authorization_test_retry",
      leaseOwner: "codex-test-retry",
      confirmed: true
    })).response.status, 201);
    const rejectedAssetTwo = (await post("/api/v1/canvas/generated-assets", { name: "1人视_风险候选_02.png", dataUrl: pngVariant(1) })).json.asset as { id: string };
    assert.equal(rejectedAssetTwo.id, rejectedAssetOne.id);
    const rejectedTwo = await post(`/api/v1/canvas/codex-runs/${retryRun.id}/items/${retryItem.id}/generated-results`, {
      authorizationId: "authorization_test_retry",
      leaseOwner: "codex-test-retry",
      assetId: rejectedAssetTwo.id,
      structureRisk: "confirmed",
      confirmed: true
    });
    assert.equal(rejectedTwo.response.status, 200);
    assert.equal(rejectedTwo.json.versionId, rejectedOne.json.versionId);
    assert.equal(rejectedTwo.json.deduplicated, true);
    assert.equal((rejectedTwo.json.validation as { retryScheduled: boolean }).retryScheduled, false);
    assert.equal((rejectedTwo.json.item as { status: string }).status, "failed");
    assert.equal((rejectedTwo.json.run as { status: string }).status, "running");
    assert.equal((rejectedTwo.json.run as { items: Array<{ status: string }> }).items[1]?.status, "queued");

    assert.equal((await post(`/api/v1/canvas/codex-runs/${retryRun.id}/text-cards`, {
      authorizationId: "authorization_test_retry",
      sourceVersionId: secondVersionId,
      kind: "prompt",
      title: "2人视结构锁定提示词",
      text: "严格保持底图体块、开口、道路与相机，只优化材质和光影。",
      idempotencyKey: "codex-prompt-test-retry-02"
    })).response.status, 201);
    assert.equal((await post(`/api/v1/canvas/codex-runs/${retryRun.id}/items/${nextItem.id}/generation-submitted`, {
      authorizationId: "authorization_test_retry",
      leaseOwner: "codex-test-retry",
      confirmed: true
    })).response.status, 201);
    const acceptedAsset = (await post("/api/v1/canvas/generated-assets", { name: "2人视_可用候选_01.png", dataUrl: pngVariant(3) })).json.asset as { id: string };
    const acceptedNext = await post(`/api/v1/canvas/codex-runs/${retryRun.id}/items/${nextItem.id}/generated-results`, {
      authorizationId: "authorization_test_retry",
      leaseOwner: "codex-test-retry",
      assetId: acceptedAsset.id,
      structureRisk: "none",
      confirmed: true
    });
    assert.equal(acceptedNext.response.status, 201);
    assert.equal((acceptedNext.json.item as { status: string }).status, "completed");
    assert.equal((acceptedNext.json.run as { status: string }).status, "completed");

    const handoffRunCall = await post("/api/v1/canvas/codex-runs", {
      authorizationId: "authorization_test_0003",
      sourceFolder: null,
      stage: "final-glass",
      action: "generate",
      sourceVersionIds: [versionId],
      maximumGenerations: 1,
      allowManualFallback: true,
      stopOnStructureRisk: true,
      confirmed: true
    });
    assert.equal(handoffRunCall.response.status, 201);
    const handoffRun = handoffRunCall.json.run as { id: string };
    assert.equal((await post(`/api/v1/canvas/codex-runs/${handoffRun.id}/pause`, {})).response.status, 200);
    const handedOff = await post(`/api/v1/canvas/codex-runs/${handoffRun.id}/handoff`, {
      targetRunner: "manual",
      reason: "Codex 额度不足，转 A 模式继续",
      confirmed: true
    });
    assert.equal(handedOff.response.status, 200);
    assert.equal((handedOff.json.run as { runner: string; items: Array<{ runner: string }> }).runner, "manual");
    assert.equal((handedOff.json.run as { items: Array<{ runner: string }> }).items[0]?.runner, "manual");
  } finally {
    await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
  }
});

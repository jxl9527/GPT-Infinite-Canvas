import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { ProjectRuntimeManager } from "../src/project-runtime-manager.js";
import { createBridgeServer } from "../src/server.js";

const pixelBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL3SAAAAABJRU5ErkJggg==";
const pixel = Buffer.from(pixelBase64, "base64");
const dataUrl = `data:image/png;base64,${pixelBase64}`;
const generatedPixelBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const generatedPixel = Buffer.from(generatedPixelBase64, "base64");
const generatedDataUrl = `data:image/png;base64,${generatedPixelBase64}`;

test("v1 HTTP 完成附件读取、结果落盘去重、完成校验和脱敏诊断", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-canvas-p1-http-"));
  const assetRoot = join(root, "assets", "originals"); await mkdir(assetRoot, { recursive: true });
  await writeFile(join(assetRoot, "厂房测试.png"), pixel);
  const projects = new ProjectRuntimeManager(join(root, ".runtime"), root); await projects.init();
  await projects.activate("project_default");
  const token = "test-local-token";
  const server = createBridgeServer({
    projects,
    token,
    canvasOrigins: ["http://127.0.0.1:9999"],
    allowedOrigins: ["http://127.0.0.1:9999", "https://chatgpt.com", "https://chat.openai.com"]
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as AddressInfo; const base = `http://127.0.0.1:${address.port}`;
  const headers = { "content-type": "application/json", "x-bridge-token": token };
  const post = async (path: string, body: unknown): Promise<{ response: Response; json: Record<string, unknown> }> => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    return { response, json: await response.json() as Record<string, unknown> };
  };
  try {
    const health = await fetch(`${base}/health`).then((response) => response.json()) as { ok: boolean; activeTaskId: string | null };
    assert.equal(health.ok, true); assert.equal(health.activeTaskId, null);

    const rejectedCanvasSession = await fetch(`${base}/api/v1/canvas/session`, {
      headers: { origin: "https://chatgpt.com" }
    });
    assert.equal(rejectedCanvasSession.status, 403);
    const canvasSession = await fetch(`${base}/api/v1/canvas/session`, {
      headers: { origin: "http://127.0.0.1:9999" }
    });
    assert.equal(canvasSession.status, 200);
    assert.equal(((await canvasSession.json()) as { token: string }).token, token);

    const imported = await post("/api/v1/canvas/assets", { name: "厂房 01.png", dataUrl });
    assert.equal(imported.response.status, 201);
    const importedAsset = imported.json.asset as {
      id: string;
      originalName: string;
      original: { relativePath: string; width: number; height: number; sha256: string };
    };
    assert.equal(importedAsset.originalName, "厂房 01.png");
    assert.equal(importedAsset.original.width, 1);
    assert.equal(importedAsset.original.height, 1);
    assert.match(importedAsset.original.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await readFile(resolve(root, importedAsset.original.relativePath)), pixel);
    const duplicateImport = await post("/api/v1/canvas/assets", { name: "相同内容.png", dataUrl });
    assert.equal(duplicateImport.response.status, 200);
    assert.equal(duplicateImport.json.deduplicated, true);
    assert.equal((duplicateImport.json.asset as { id: string }).id, importedAsset.id);
    const listedAssets = await fetch(`${base}/api/v1/canvas/assets`, { headers }).then((response) => response.json()) as {
      assets: unknown[];
    };
    assert.equal(listedAssets.assets.length, 1);
    const originalResponse = await fetch(`${base}/api/v1/canvas/assets/${importedAsset.id}/original`, { headers });
    assert.equal(originalResponse.status, 200);
    assert.equal(originalResponse.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await originalResponse.arrayBuffer()), pixel);
    const derivatives = await post(`/api/v1/canvas/assets/${importedAsset.id}/derivatives`, {
      displayDataUrl: dataUrl,
      thumbnailDataUrl: dataUrl
    });
    assert.equal(derivatives.response.status, 200);
    const derivativeAsset = derivatives.json.asset as {
      display: { relativePath: string };
      thumbnail: { relativePath: string };
    };
    assert.match(derivativeAsset.display.relativePath, /^assets\/display\//);
    assert.match(derivativeAsset.thumbnail.relativePath, /^assets\/thumbnails\//);
    const displayResponse = await fetch(`${base}/api/v1/canvas/assets/${importedAsset.id}/display`, { headers });
    assert.equal(displayResponse.status, 200);
    assert.deepEqual(Buffer.from(await displayResponse.arrayBuffer()), pixel);
    const assetIndex = JSON.parse(await readFile(join(root, "assets", "asset-index.json"), "utf8")) as { assets: unknown[] };
    assert.equal(assetIndex.assets.length, 1);
    const annotationExport = await post("/api/v1/canvas/annotation-exports", {
      name: "厂房批注图.png",
      dataUrl
    });
    assert.equal(annotationExport.response.status, 201);
    const annotationAsset = annotationExport.json.asset as {
      id: string;
      kind: string;
      original: { relativePath: string };
    };
    assert.equal(annotationAsset.kind, "annotation-export");
    assert.match(annotationAsset.original.relativePath, /^annotations\//);
    assert.deepEqual(await readFile(resolve(root, annotationAsset.original.relativePath)), pixel);
    const duplicateExport = await post("/api/v1/canvas/annotation-exports", {
      name: "相同批注图.png",
      dataUrl
    });
    assert.equal(duplicateExport.response.status, 200);
    assert.equal(duplicateExport.json.deduplicated, true);
    const assetIndexAfterExport = JSON.parse(await readFile(join(root, "assets", "asset-index.json"), "utf8")) as { assets: unknown[] };
    assert.equal(assetIndexAfterExport.assets.length, 2);

    const versionId = "version_00000000-0000-0000-0000-000000000001";
    const project = {
      schemaVersion: "1.0",
      projectId: "project_00000000-0000-0000-0000-000000000001",
      title: "HTTP 自动保存测试",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revision: 20,
      canvas: {
        viewport: { x: 72, y: 54, scale: 0.74 },
        nodes: [{
          id: "node_00000000-0000-0000-0000-000000000001",
          type: "image",
          x: 120,
          y: 80,
          width: 640,
          height: 427,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          zIndex: 0,
          locked: false,
          visible: true,
          payload: { imageVersionId: versionId, fit: "cover" }
        }]
      },
      assets: [importedAsset],
      versions: [{
        id: versionId,
        assetId: importedAsset.id,
        origin: "imported",
        parentVersionId: null,
        taskId: null,
        createdAt: new Date().toISOString()
      }],
      taskLinks: []
    };
    const savedProject = await post("/api/v1/canvas/project", { project });
    assert.equal(savedProject.response.status, 200);
    assert.match(String(savedProject.json.snapshotRelativePath), /^canvas\/snapshots\//);
    const restoredProject = await fetch(`${base}/api/v1/canvas/project`, { headers })
      .then((response) => response.json()) as { project: { revision: number } };
    assert.equal(restoredProject.project.revision, 20);
    const invalidProject = structuredClone(project);
    invalidProject.revision = 21;
    invalidProject.versions[0]!.assetId = "asset_missing";
    assert.equal((await post("/api/v1/canvas/project", { project: invalidProject })).response.status, 422);

    const payload = {
      taskType: "edit",
      target: { chatMode: "new" },
      prompt: "保持建筑结构不变，不得增加或删除建筑",
      attachments: [{ role: "edit-target", name: "厂房测试.png", relativePath: "assets/originals/厂房测试.png" }]
    };
    const unauthorized = await fetch(`${base}/api/v1/tasks`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
    });
    assert.equal(unauthorized.status, 401);

    const rejectedOrigin = await fetch(`${base}/api/v1/tasks`, {
      headers: { "x-bridge-token": token, origin: "https://evil.example" }
    });
    assert.equal(rejectedOrigin.status, 403);

    const createdCall = await post("/api/v1/tasks", payload); assert.equal(createdCall.response.status, 201);
    const created = (createdCall.json.task ?? {}) as { id: string; status: string; attachments: Array<{ id: string }> };
    assert.equal(created.status, "queued"); assert.equal(created.attachments.length, 1);

    const attachment = await fetch(`${base}/api/v1/tasks/${created.id}/attachments/${created.attachments[0]?.id}`, {
      headers: { "x-bridge-token": token, origin: "https://chatgpt.com" }
    });
    assert.equal(attachment.status, 200); assert.equal(attachment.headers.get("content-type"), "image/png");
    assert.equal(attachment.headers.get("access-control-allow-origin"), "https://chatgpt.com");
    assert.deepEqual(Buffer.from(await attachment.arrayBuffer()), pixel);

    assert.equal((await post(`/api/v1/tasks/${created.id}/claim`, {})).response.status, 200);
    for (const status of ["uploading", "ready-to-submit", "submitted", "generating", "collecting"]) {
      const advanced = await post(`/api/v1/tasks/${created.id}/status`, { status, by: "test" });
      assert.equal(advanced.response.status, 200);
    }

    const rejectedOriginal = await post(`/api/v1/tasks/${created.id}/results`, { dataUrl });
    assert.equal(rejectedOriginal.response.status, 422);
    assert.equal((rejectedOriginal.json.error as { code?: string }).code, "RESULT_MATCHES_ATTACHMENT");
    const first = await post(`/api/v1/tasks/${created.id}/results`, { dataUrl: generatedDataUrl });
    const duplicate = await post(`/api/v1/tasks/${created.id}/results`, { dataUrl: generatedDataUrl });
    assert.equal(first.response.status, 201); assert.equal(first.json.deduplicated, false);
    assert.equal(duplicate.response.status, 200); assert.equal(duplicate.json.deduplicated, true);
    const resultFiles = (await readdir(join(root, "runs", created.id, "results"))).filter((name) => name.endsWith(".png"));
    assert.equal(resultFiles.length, 1);
    const index = JSON.parse(await readFile(join(root, "runs", created.id, "result-index.json"), "utf8")) as { results: unknown[] };
    assert.equal(index.results.length, 1);
    const resultId = (first.json.result as { id: string }).id;
    const resultResponse = await fetch(`${base}/api/v1/tasks/${created.id}/results/${resultId}`, { headers });
    assert.equal(resultResponse.status, 200);
    assert.equal(resultResponse.headers.get("x-content-type-options"), "nosniff");
    assert.match(resultResponse.headers.get("x-result-sha256") ?? "", /^[a-f0-9]{64}$/);
    assert.deepEqual(Buffer.from(await resultResponse.arrayBuffer()), generatedPixel);
    const missingResult = await fetch(`${base}/api/v1/tasks/${created.id}/results/missing`, { headers });
    assert.equal(missingResult.status, 404);

    const generatedAsset = await post("/api/v1/canvas/generated-assets", {
      name: "生成结果.png",
      dataUrl: generatedDataUrl
    });
    assert.equal(generatedAsset.response.status, 201);
    assert.equal((generatedAsset.json.asset as { kind: string }).kind, "generated");

    const completed = await post(`/api/v1/tasks/${created.id}/complete`, { by: "test" });
    assert.equal(completed.response.status, 200);
    assert.equal(((completed.json.task ?? {}) as { status: string }).status, "completed");
    const delayedResult = await post(`/api/v1/tasks/${created.id}/results`, { dataUrl: generatedDataUrl });
    assert.equal(delayedResult.response.status, 409);

    const exported = await post("/api/v1/diagnostics/export", {}); assert.equal(exported.response.status, 201);
    const diagnostic = exported.json.diagnostic as { relativePath: string; sha256: string };
    assert.match(diagnostic.sha256, /^[a-f0-9]{64}$/);
    const diagnosticText = await readFile(resolve(root, diagnostic.relativePath), "utf8");
    assert.doesNotMatch(diagnosticText, /test-local-token/);
    assert.doesNotMatch(diagnosticText, /保持建筑结构不变/);
    assert.doesNotMatch(diagnosticText, /厂房测试\.png/);
    assert.match(diagnosticText, new RegExp(created.id));

    const workbench = await fetch(`${base}/api/v1/workbench/projects`, { headers })
      .then((response) => response.json()) as { projects: Array<{ id: string; name: string }>; activeProjectId: string | null };
    assert.equal(workbench.activeProjectId, "project_default");
    assert.equal(workbench.projects.length, 1);

    const savedPromptCall = await post("/api/v1/workbench/prompts", {
      title: "暖灰工业建筑",
      content: "优化暖灰材质与入口光影，保持建筑结构不变。"
    });
    assert.equal(savedPromptCall.response.status, 200);
    const savedPrompt = savedPromptCall.json.prompt as { id: string; title: string; content: string };
    assert.match(savedPrompt.id, /^prompt_[a-f0-9-]{36}$/);
    assert.equal(savedPrompt.title, "暖灰工业建筑");
    const listedPrompts = await fetch(`${base}/api/v1/workbench/prompts`, { headers })
      .then((response) => response.json()) as { prompts: Array<{ id: string; title: string }> };
    assert.equal(listedPrompts.prompts.length, 1);
    assert.equal(listedPrompts.prompts[0]?.id, savedPrompt.id);
    const updatedPromptCall = await post("/api/v1/workbench/prompts", {
      id: savedPrompt.id,
      title: "暖灰工业建筑",
      content: "调整为克制暖灰表达，强化主入口光影。"
    });
    assert.equal((updatedPromptCall.json.prompt as { content: string }).content, "调整为克制暖灰表达，强化主入口光影。");
    assert.equal((await post(`/api/v1/workbench/prompts/${savedPrompt.id}/delete`, {})).response.status, 200);
    const promptLibraryFile = JSON.parse(
      await readFile(join(root, ".runtime", "workbench", "prompt-library.json"), "utf8")
    ) as { prompts: unknown[] };
    assert.equal(promptLibraryFile.prompts.length, 0);

    const requirementsMarkdown = `# 项目需求

## 项目基本信息

- 项目名称：空白产业园方案
- 项目类型：产业园

## 建设规模

- 两栋厂房和一栋办公楼

## 主要功能

- 生产、研发和办公

## 设计目标

- 建立高效、克制的现代产业园

## 必须保持的内容

- 保持建筑数量、道路和场地边界
`;
    const requirementsPreviewCall = await post("/api/v1/workbench/requirements/preview", {
      sourceName: "项目需求.md",
      content: requirementsMarkdown
    });
    assert.equal(requirementsPreviewCall.response.status, 200);
    assert.equal(
      (requirementsPreviewCall.json.preview as { projectNameSuggestion: string }).projectNameSuggestion,
      "空白产业园方案"
    );
    const blankProjectCall = await post("/api/v1/workbench/projects", { name: "快速空白项目" });
    assert.equal(blankProjectCall.response.status, 201);
    const blankProject = blankProjectCall.json.project as { id: string; requirements: null };
    assert.equal(blankProject.requirements, null);
    const blankMetadata = JSON.parse(
      await readFile(join(root, ".runtime", "projects", blankProject.id, "project-meta.json"), "utf8")
    ) as { requirements?: unknown };
    assert.equal(blankMetadata.requirements, undefined);
    const createdProjectCall = await post("/api/v1/workbench/projects", {
      name: "空白产业园方案",
      requirements: { sourceName: "项目需求.md", content: requirementsMarkdown }
    });
    assert.equal(createdProjectCall.response.status, 201);
    const createdProject = createdProjectCall.json.project as {
      id: string;
      name: string;
      requirements: { sourceName: string; sectionCount: number };
    };
    assert.equal(createdProject.name, "空白产业园方案");
    assert.equal(createdProject.requirements.sourceName, "项目需求.md");
    assert.equal(createdProject.requirements.sectionCount, 5);
    const createdProjectRoot = join(root, ".runtime", "projects", createdProject.id);
    assert.equal(
      await readFile(join(createdProjectRoot, "inputs", "requirements", "项目需求_v1.md"), "utf8"),
      `${requirementsMarkdown.trimEnd()}\n`
    );
    const storedContext = JSON.parse(
      await readFile(join(createdProjectRoot, "context", "project-context.json"), "utf8")
    ) as { generationContext: string };
    assert.match(storedContext.generationContext, /保持建筑数量、道路和场地边界/);
    const activatedProject = await post(`/api/v1/workbench/projects/${createdProject.id}/activate`, {});
    assert.equal(activatedProject.response.status, 200);
    const activeRequirements = await fetch(`${base}/api/v1/canvas/project-requirements`, { headers })
      .then((response) => response.json()) as {
        requirements: { sourceName: string; generationContext: string };
      };
    assert.equal(activeRequirements.requirements.sourceName, "项目需求.md");
    assert.match(activeRequirements.requirements.generationContext, /项目背景与设计约束/);
    const editedRequirementsMarkdown = requirementsMarkdown.replace(
      "建立高效、克制的现代产业园",
      "建立高效、克制并强调低碳策略的现代产业园"
    );
    const editedRequirements = await post("/api/v1/canvas/project-requirements", {
      content: editedRequirementsMarkdown
    });
    assert.equal(editedRequirements.response.status, 200);
    assert.match(
      (editedRequirements.json.requirements as { generationContext: string }).generationContext,
      /低碳策略/
    );
    assert.equal(
      await readFile(join(createdProjectRoot, "inputs", "requirements", "项目需求_v1.md"), "utf8"),
      `${requirementsMarkdown.trimEnd()}\n`
    );
    assert.equal(
      await readFile(join(createdProjectRoot, "inputs", "requirements", "项目需求_v2.md"), "utf8"),
      `${editedRequirementsMarkdown.trimEnd()}\n`
    );
    assert.match(
      await readFile(join(createdProjectRoot, "logs", "requirements-import.ndjson"), "utf8"),
      /requirements-edited/
    );
    const emptyProject = await fetch(`${base}/api/v1/canvas/project`, { headers })
      .then((response) => response.json()) as { project: unknown };
    assert.equal(emptyProject.project, null);
  } finally {
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
});

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  ERROR_HTTP_STATUS,
  ProtocolError,
  parseCreateTaskInput,
  type EventActor,
  type GenerationStatus,
  type GenerationTask
} from "@gpt-canvas/shared";
import type { AttachmentPayload } from "./attachments.js";
import { readTaskAttachment, resolveTaskAttachments } from "./attachments.js";
import type { CanvasAssetRepository } from "./canvas-asset-repository.js";
import type { ProjectRuntimeManager } from "./project-runtime-manager.js";
import type { ResultRepository } from "./result-repository.js";
import { exportSimpleImages } from "./simple-export.js";

export interface BridgeServerOptions {
  projects: ProjectRuntimeManager;
  token: string;
  allowedOrigins?: readonly string[];
  canvasOrigins?: readonly string[];
  selectProjectFolder?: () => Promise<string | null>;
}

type JsonObject = Record<string, unknown>;

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendAttachment(response: ServerResponse, payload: AttachmentPayload): void {
  response.writeHead(200, {
    "content-type": payload.mime,
    "content-length": payload.bytes.byteLength,
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(payload.name)}`,
    "cache-control": "no-store"
  });
  response.end(payload.bytes);
}

function sendCanvasAsset(
  response: ServerResponse,
  payload: Awaited<ReturnType<CanvasAssetRepository["readOriginal"]>>
): void {
  response.writeHead(200, {
    "content-type": payload.asset.original.mime,
    "content-length": payload.bytes.byteLength,
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(payload.asset.originalName)}`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(payload.bytes);
}

function sendGenerationResult(
  response: ServerResponse,
  payload: Awaited<ReturnType<ResultRepository["read"]>>
): void {
  response.writeHead(200, {
    "content-type": payload.result.mime,
    "content-length": payload.bytes.byteLength,
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(payload.result.filename)}`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "x-result-sha256": payload.result.sha256
  });
  response.end(payload.bytes);
}

async function readJson(request: IncomingMessage, maximumBytes = 1_048_576): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.byteLength;
    if (size > maximumBytes) throw new ProtocolError("INVALID_INPUT", `JSON 请求体超过 ${Math.round(maximumBytes / 1_048_576)} MiB`);
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ProtocolError("INVALID_INPUT", "JSON 请求体无效"); }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actor(value: unknown): EventActor {
  return value === "extension" || value === "user" || value === "recovery" || value === "test" ? value : "service";
}

function errorPayload(error: unknown): { status: number; code: "INTERNAL_ERROR" | ProtocolError["code"]; body: unknown; message: string } {
  if (error instanceof ProtocolError) {
    return {
      status: error.httpStatus,
      code: error.code,
      message: error.message,
      body: { ok: false, error: { code: error.code, message: error.message } }
    };
  }
  return {
    status: ERROR_HTTP_STATUS.INTERNAL_ERROR,
    code: "INTERNAL_ERROR",
    message: "本地服务发生未分类错误",
    body: { ok: false, error: { code: "INTERNAL_ERROR", message: "本地服务发生未分类错误" } }
  };
}

export function createBridgeServer(options: BridgeServerOptions): Server {
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const canvasOrigins = new Set(options.canvasOrigins ?? []);
  return createServer(async (request, response) => {
    const startedAt = performance.now();
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const taskId = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)/)?.[1];
    try {
      const origin = request.headers.origin;
      if (origin && !allowedOrigins.has(origin) && !origin.startsWith("chrome-extension://")) {
        throw new ProtocolError("ORIGIN_REJECTED", "请求来源不在允许列表");
      }
      if (origin) {
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("vary", "origin");
      }
      response.setHeader("access-control-allow-headers", "content-type, x-bridge-token, x-canvas-project");
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }

      if (request.method === "GET" && url.pathname === "/health") {
        const current = options.projects.current();
        send(response, 200, {
          ok: true,
          schemaVersion: "1.0",
          releaseVersion: "0.6.0",
          simpleRenderConcurrency: 2,
          activeProjectId: current?.id ?? null,
          activeTaskId: current?.store.getActive()?.id ?? null
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/canvas/session") {
        if (origin && !canvasOrigins.has(origin)) {
          throw new ProtocolError("ORIGIN_REJECTED", "只有本地画布可以取得画布会话");
        }
        send(response, 200, { ok: true, token: options.token }); return;
      }
      if (!url.pathname.startsWith("/api/v1/")) throw new ProtocolError("TASK_NOT_FOUND", "接口不存在");
      if (request.headers["x-bridge-token"] !== options.token) throw new ProtocolError("AUTH_REQUIRED", "本地会话令牌无效");

      if (request.method === "GET" && url.pathname === "/api/v1/workbench/projects") {
        send(response, 200, {
          ok: true,
          projects: await options.projects.list(),
          activeProjectId: options.projects.current()?.id ?? null
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/workbench/projects") {
        const body = await readJson(request, 2 * 1_048_576);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "新建项目请求必须是 JSON 对象");
        const project = await options.projects.create(body.name, body.requirements);
        send(response, 201, { ok: true, project });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/workbench/requirements/preview") {
        const body = await readJson(request, 2 * 1_048_576);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "项目需求预解析请求必须是 JSON 对象");
        const preview = options.projects.previewRequirements(body.sourceName, body.content);
        send(response, 200, { ok: true, preview });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/workbench/prompts") {
        send(response, 200, { ok: true, prompts: options.projects.listPrompts() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/workbench/prompts") {
        const body = await readJson(request, 4 * 1_048_576);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "提示词保存请求必须是 JSON 对象");
        const prompt = await options.projects.savePrompt(body.id, body.title, body.content, body);
        send(response, 200, { ok: true, prompt });
        return;
      }
      const deletePromptId = url.pathname.match(/^\/api\/v1\/workbench\/prompts\/([^/]+)\/delete$/)?.[1];
      if (request.method === "POST" && deletePromptId) {
        await options.projects.deletePrompt(deletePromptId);
        send(response, 200, { ok: true });
        return;
      }
      const activateProjectId = url.pathname.match(/^\/api\/v1\/workbench\/projects\/([^/]+)\/activate$/)?.[1];
      if (request.method === "POST" && activateProjectId) {
        const project = await options.projects.activate(decodeURIComponent(activateProjectId));
        send(response, 200, {
          ok: true,
          project: (await options.projects.list()).find((candidate) => candidate.id === project.id)
        });
        return;
      }
      const deleteProjectId = url.pathname.match(/^\/api\/v1\/workbench\/projects\/([^/]+)\/delete$/)?.[1];
      if (request.method === "POST" && deleteProjectId) {
        const deleted = await options.projects.deleteProject(decodeURIComponent(deleteProjectId));
        send(response, 200, { ok: true, deleted });
        return;
      }

      const project = options.projects.current();
      if (request.headers["x-canvas-project"] && request.headers["x-canvas-project"] !== project?.id) throw new ProtocolError("TASK_LOCKED", "其他窗口已切换项目，请重新打开当前项目");
      if (!project) throw new ProtocolError("TASK_LOCKED", "请先在项目工作台选择或新建项目");

      if (request.method === "GET" && url.pathname === "/api/v1/canvas/project-requirements") {
        send(response, 200, { ok: true, requirements: await options.projects.activeRequirements() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/canvas/project-requirements") {
        const body = await readJson(request, 2 * 1_048_576);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "项目背景更新请求必须是 JSON 对象");
        send(response, 200, {
          ok: true,
          requirements: await options.projects.saveActiveRequirements(body.content)
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/canvas/assets") {
        send(response, 200, { ok: true, assets: project.canvasAssets.list() }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/canvas/codex-capabilities") {
        const canvasProject = project.canvasProject.read();
        send(response, 200, {
          ok: true,
          capabilities: {
            schemaVersion: "1.0",
            bridgeVersion: "0.6.0",
            pluginProtocolVersion: "1.0",
            activeProjectId: project.id,
            canvasProjectLoaded: Boolean(canvasProject),
            canvasRevision: typeof canvasProject?.revision === "number" ? canvasProject.revision : null,
            sourcePolicy: "read-only-copy-import",
            supportedStages: ["preflight", "scene-optimization", "final-glass"],
            supportedTools: [
              "d5_get_capabilities",
              "d5_scan_project_folder",
              "d5_import_manifest",
              "d5_get_workflow_state",
              "d5_create_run",
              "d5_register_text_card",
              "d5_get_run_item_inputs",
              "d5_mark_generation_submitted",
              "d5_register_generated_result",
              "d5_pause_run",
              "d5_resume_run",
              "d5_handoff_run_items"
            ],
            automaticFinalSelection: false,
            arbitraryFileWrite: false,
            arbitraryCommandExecution: false
          }
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/canvas/folder-manifests/scan") {
        const body = await readJson(request);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "项目文件夹扫描请求必须是 JSON 对象");
        const manifest = await project.folderManifests.scan(body.sourceRoot, body.includeSubfolders);
        send(response, 201, { ok: true, manifest }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/canvas/folder-manifests/select-folder") {
        if (!options.selectProjectFolder) {
          throw new ProtocolError("INVALID_INPUT", "本地服务未启用系统文件夹选择器，请粘贴绝对路径");
        }
        const sourceRoot = await options.selectProjectFolder();
        send(response, 200, { ok: true, sourceRoot, cancelled: sourceRoot === null }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/canvas/codex-runs") {
        const body = await readJson(request, 2 * 1_048_576);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "Codex 批次创建请求必须是 JSON 对象");
        if (typeof body.manifestId === "string" && body.manifestId.trim()) {
          const manifest = await project.folderManifests.read(body.manifestId);
          if (body.sourceFolder !== manifest.sourceRoot) {
            throw new ProtocolError("TASK_LOCKED", "授权单源文件夹与已确认清单不一致");
          }
        }
        const result = await project.canvasProject.createCodexRun(body);
        await project.diagnostics.log({
          event: result.deduplicated ? "codex-run-deduplicated" : "codex-run-created",
          message: `${String(result.run.id)} ${String(result.run.workflowStage)}`
        });
        send(response, result.deduplicated ? 200 : 201, { ok: true, ...result }); return;
      }
      const codexRunMatch = url.pathname.match(/^\/api\/v1\/canvas\/codex-runs\/([^/]+)\/(text-cards|pause|resume)$/);
      if (request.method === "POST" && codexRunMatch) {
        const runId = decodeURIComponent(codexRunMatch[1] ?? "");
        const operation = codexRunMatch[2];
        const body = await readJson(request, 2 * 1_048_576);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "Codex 批次操作请求必须是 JSON 对象");
        if (operation === "text-cards") {
          const result = await project.canvasProject.registerCodexTextCard({ ...body, runId });
          await project.diagnostics.log({
            event: result.deduplicated ? "codex-text-card-deduplicated" : "codex-text-card-registered",
            message: `${runId} ${String(result.card.id)}`
          });
          send(response, result.deduplicated ? 200 : 201, { ok: true, ...result }); return;
        }
        const result = await project.canvasProject.transitionCodexRun({
          ...body,
          runId,
          action: operation === "pause" ? "pause" : "resume"
        });
        await project.diagnostics.log({ event: `codex-run-${operation}`, message: runId });
        send(response, 200, { ok: true, ...result }); return;
      }
      const codexItemMatch = url.pathname.match(/^\/api\/v1\/canvas\/codex-runs\/([^/]+)\/items\/([^/]+)\/(inputs|generation-submitted|generated-results)$/);
      if (codexItemMatch) {
        const runId = decodeURIComponent(codexItemMatch[1] ?? "");
        const itemId = decodeURIComponent(codexItemMatch[2] ?? "");
        const operation = codexItemMatch[3];
        if (request.method === "GET" && operation === "inputs") {
          send(response, 200, { ok: true, item: project.canvasProject.readCodexRunItemInputs({ runId, itemId }) }); return;
        }
        if (request.method === "POST" && operation === "generation-submitted") {
          const body = await readJson(request);
          if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "Codex 生图提交请求必须是 JSON 对象");
          const result = await project.canvasProject.markCodexGenerationSubmitted({ ...body, runId, itemId });
          await project.diagnostics.log({
            event: result.deduplicated ? "codex-generation-submit-deduplicated" : "codex-generation-submitted",
            message: `${runId} ${itemId}`
          });
          send(response, result.deduplicated ? 200 : 201, { ok: true, ...result }); return;
        }
        if (request.method === "POST" && operation === "generated-results") {
          const body = await readJson(request);
          if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "Codex 结果登记请求必须是 JSON 对象");
          const asset = typeof body.assetId === "string" ? project.canvasAssets.get(body.assetId) : undefined;
          if (!asset) throw new ProtocolError("TASK_NOT_FOUND", "Codex 生成结果资产不存在");
          const result = await project.canvasProject.registerCodexGeneratedResult({ ...body, runId, itemId }, asset);
          await project.diagnostics.log({
            event: result.deduplicated ? "codex-generated-result-deduplicated" : "codex-generated-result-registered",
            message: `${runId} ${itemId} ${result.versionId} ${String(result.validation.passed)}`
          });
          send(response, result.deduplicated ? 200 : 201, { ok: true, ...result }); return;
        }
      }
      const codexHandoffRunId = url.pathname.match(/^\/api\/v1\/canvas\/codex-runs\/([^/]+)\/handoff$/)?.[1];
      if (request.method === "POST" && codexHandoffRunId) {
        const body = await readJson(request);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "A/B 接管请求必须是 JSON 对象");
        const runId = decodeURIComponent(codexHandoffRunId);
        const result = await project.canvasProject.handoffRun({ ...body, runId });
        await project.diagnostics.log({ event: "workflow-run-handoff", message: `${runId} ${String(result.run.runner)}` });
        send(response, 200, { ok: true, ...result }); return;
      }
      const folderManifestMatch = url.pathname.match(/^\/api\/v1\/canvas\/folder-manifests\/([^/]+)(?:\/(import))?$/);
      if (folderManifestMatch) {
        const manifestId = decodeURIComponent(folderManifestMatch[1] ?? "");
        if (request.method === "GET" && !folderManifestMatch[2]) {
          send(response, 200, { ok: true, manifest: await project.folderManifests.read(manifestId) }); return;
        }
        if (request.method === "POST" && folderManifestMatch[2] === "import") {
          const body = await readJson(request);
          if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "项目文件夹导入请求必须是 JSON 对象");
          const imported = await project.folderManifests.importManifest(manifestId, body.selectedRelativePaths);
          send(response, imported.completed ? 201 : 207, { ok: imported.completed, import: imported }); return;
        }
      }
      if (request.method === "GET" && url.pathname === "/api/v1/canvas/delivery-target") {
        send(response, 200, { ok: true, target: await project.delivery.readTarget() }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/canvas/delivery-target") {
        const body = await readJson(request);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "批量导出目录请求必须是 JSON 对象");
        send(response, 200, { ok: true, target: await project.delivery.saveTarget(body.targetDirectory) }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/canvas/final-glass/batch-export") {
        const body = await readJson(request);
        if (!isRecord(body) || !Array.isArray(body.selections)) {
          throw new ProtocolError("INVALID_INPUT", "最终玻璃批量导出请求必须包含 selections 数组");
        }
        const result = await project.delivery.exportSelected(body.selections);
        send(response, result.completed ? 201 : 207, { ok: result.completed, export: result }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/canvas/project") {
        send(response, 200, { ok: true, project: project.canvasProject.read() }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/canvas/project/conflict-draft") {
        const body = await readJson(request, 32 * 1_048_576);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "冲突草稿保存请求必须是 JSON 对象");
        const recovered = await project.canvasProject.preserveConflictDraft(body.project);
        send(response, 201, { ok: true, ...recovered }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/canvas/project") {
        const body = await readJson(request, 32 * 1_048_576);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "画布项目保存请求必须是 JSON 对象");
        const saved = await project.canvasProject.save(body.project, body.forceSnapshot === true,
          typeof body.expectedRevision === "number" ? body.expectedRevision : undefined);
        send(response, 200, { ok: true, ...saved }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/canvas/assets") {
        const body = await readJson(request, 60 * 1_048_576);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "图片导入请求必须是 JSON 对象");
        const imported = await project.canvasAssets.importDataUrl(body.name, body.dataUrl);
        send(response, imported.deduplicated ? 200 : 201, { ok: true, ...imported }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/canvas/annotation-exports") {
        const body = await readJson(request, 60 * 1_048_576);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "批注导出请求必须是 JSON 对象");
        const exported = await project.canvasAssets.saveAnnotationExport(body.name, body.dataUrl);
        send(response, exported.deduplicated ? 200 : 201, { ok: true, ...exported }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/canvas/generated-assets") {
        const body = await readJson(request, 60 * 1_048_576);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "生成结果导入请求必须是 JSON 对象");
        const imported = await project.canvasAssets.saveGeneratedAsset(body.name, body.dataUrl);
        send(response, imported.deduplicated ? 200 : 201, { ok: true, ...imported }); return;
      }
      const derivativesMatch = url.pathname.match(/^\/api\/v1\/canvas\/assets\/([^/]+)\/derivatives$/);
      if (request.method === "POST" && derivativesMatch) {
        const body = await readJson(request, 60 * 1_048_576);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "显示图请求必须是 JSON 对象");
        const saved = await project.canvasAssets.saveDerivatives(
          decodeURIComponent(derivativesMatch[1] ?? ""),
          body.displayDataUrl,
          body.thumbnailDataUrl
        );
        send(response, 200, { ok: true, ...saved }); return;
      }
      const canvasAssetId = url.pathname.match(/^\/api\/v1\/canvas\/assets\/([^/]+)\/original$/)?.[1];
      if (request.method === "GET" && canvasAssetId) {
        sendCanvasAsset(response, await project.canvasAssets.readOriginal(decodeURIComponent(canvasAssetId))); return;
      }
      const renditionMatch = url.pathname.match(/^\/api\/v1\/canvas\/assets\/([^/]+)\/(display|thumbnail)$/);
      if (request.method === "GET" && renditionMatch) {
        sendCanvasAsset(
          response,
          await project.canvasAssets.readRendition(
            decodeURIComponent(renditionMatch[1] ?? ""),
            renditionMatch[2] as "display" | "thumbnail"
          )
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/tasks") {
        send(response, 200, { ok: true, tasks: project.store.list() }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/tasks/active") {
        send(response, 200, { ok: true, task: project.store.getActive() ?? null }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/tasks") {
        const input = parseCreateTaskInput(await readJson(request));
        if (input.simpleRender) {
          const document = project.canvasProject.read();
          const preferences = document?.simple as { batch?: { id: string; prompt: string; concurrency: number; paused: boolean; items: Array<{ id: string; sourceVersionId: string }> } } | undefined;
          const run = preferences?.batch;
          if (!run || run.id !== input.simpleRender.batchId || run.prompt !== input.prompt || run.concurrency !== input.simpleRender.concurrency
            || !run.items.some((item) => item.id === input.simpleRender!.itemId && item.sourceVersionId === input.simpleRender!.sourceVersionId)) throw new ProtocolError("INVALID_INPUT", "任务与已保存的批次快照不一致");
          if (run.paused) throw new ProtocolError("TASK_LOCKED", "批次已暂停");
          const versions = document?.versions as Array<{ id: string; assetId: string }> | undefined;
          const version = versions?.find((item) => item.id === input.simpleRender!.sourceVersionId);
          const assets = document?.assets as Array<{ id: string; original: { relativePath: string } }> | undefined;
          const asset = assets?.find((item) => item.id === version?.assetId);
          if (!asset || asset.original.relativePath !== input.attachments[0]?.relativePath
            || input.target.localProject?.id !== project.id) throw new ProtocolError("INVALID_INPUT", "底图未保存在当前项目，不能发送");
          const workflow = document?.workflow as { batchRun?: { status?: string } } | undefined;
          if (workflow?.batchRun && workflow.batchRun.status !== "completed") throw new ProtocolError("TASK_LOCKED", "旧版批次尚未结束，请先从旧版入口处理");
        }
        const attachments = await resolveTaskAttachments(project.projectRoot, input.attachments);
        const task = await project.store.create(input, attachments);
        send(response, 201, { ok: true, task }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/diagnostics/export") {
        const diagnostic = await project.diagnostics.exportBundle(project.store);
        send(response, 201, { ok: true, diagnostic }); return;
      }

      const resultReadMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)\/results\/([^/]+)$/);
      if (request.method === "GET" && resultReadMatch) {
        sendGenerationResult(
          response,
          await project.results.read(
            decodeURIComponent(resultReadMatch[1] ?? ""),
            decodeURIComponent(resultReadMatch[2] ?? "")
          )
        );
        return;
      }

      const match = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)(?:\/(claim|status|handoff|results|text-result|complete)|\/attachments\/([^/]+))?$/);
      if (!match) throw new ProtocolError("TASK_NOT_FOUND", "接口不存在");
      const id = decodeURIComponent(match[1] ?? ""); const action = match[2]; const attachmentId = match[3];
      const task = project.store.get(id);
      if (!task) throw new ProtocolError("TASK_NOT_FOUND", `任务不存在：${id}`);
      if (request.method === "GET" && !action && !attachmentId) { send(response, 200, { ok: true, task }); return; }
      if (request.method === "GET" && attachmentId) {
        sendAttachment(response, await readTaskAttachment(project.projectRoot, task, decodeURIComponent(attachmentId))); return;
      }
      if (request.method !== "POST") throw new ProtocolError("TASK_NOT_FOUND", "接口不存在");
      if (action === "claim") { send(response, 200, { ok: true, task: await project.store.claim(id) }); return; }
      if (action === "results") {
        const body = await readJson(request, 60 * 1_048_576);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "结果请求体必须是 JSON 对象");
        const stored = await project.results.saveDataUrl(id, body.dataUrl, "visible-page");
        send(response, stored.deduplicated ? 200 : 201, { ok: true, ...stored }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/canvas/export-images") {
        const body = await readJson(request);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "导出请求无效");
        send(response, 200, { ok: true, ...await exportSimpleImages(project, body.directory, body.selections) }); return;
      }
      if (action === "text-result") {
        const body = await readJson(request, 256 * 1_024);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "文字结果请求体必须是 JSON 对象");
        const stored = await project.results.saveText(id, body.text, "visible-page");
        send(response, stored.deduplicated ? 200 : 201, { ok: true, ...stored }); return;
      }

      const body = await readJson(request);
      if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "请求体必须是 JSON 对象");
      if (action === "status") {
        if (typeof body.status !== "string") throw new ProtocolError("INVALID_INPUT", "status 无效");
        const updated = await project.store.transition(id, body.status as GenerationStatus, actor(body.by), typeof body.note === "string" ? body.note : undefined);
        send(response, 200, { ok: true, task: updated }); return;
      }
      if (action === "handoff") {
        const reason = typeof body.reason === "string" ? body.reason : "";
        const steps = Array.isArray(body.completedSteps) ? body.completedSteps as GenerationStatus[] : [];
        send(response, 200, { ok: true, task: await project.store.handoff(id, reason, steps, actor(body.by)) }); return;
      }
      if (action === "complete") { send(response, 200, { ok: true, task: await project.store.complete(id, actor(body.by)) }); return; }
      throw new ProtocolError("TASK_NOT_FOUND", "接口不存在");
    } catch (error) {
      const failure = errorPayload(error); send(response, failure.status, failure.body);
      await options.projects.diagnostics().log({
        level: "error",
        event: "request-error",
        ...(taskId ? { taskId: decodeURIComponent(taskId) } : {}),
        errorCode: failure.code,
        method: request.method ?? "UNKNOWN",
        path: url.pathname,
        httpStatus: failure.status,
        message: failure.message
      }).catch(() => undefined);
    } finally {
      await options.projects.diagnostics().log({
        event: "request-complete",
        ...(taskId ? { taskId: decodeURIComponent(taskId) } : {}),
        method: request.method ?? "UNKNOWN",
        path: url.pathname,
        httpStatus: response.statusCode,
        durationMs: performance.now() - startedAt
      }).catch(() => undefined);
    }
  });
}

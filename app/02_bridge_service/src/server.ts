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

export interface BridgeServerOptions {
  projects: ProjectRuntimeManager;
  token: string;
  allowedOrigins?: readonly string[];
  canvasOrigins?: readonly string[];
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
      response.setHeader("access-control-allow-headers", "content-type, x-bridge-token");
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }

      if (request.method === "GET" && url.pathname === "/health") {
        const current = options.projects.current();
        send(response, 200, {
          ok: true,
          schemaVersion: "1.0",
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
        const body = await readJson(request);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "提示词保存请求必须是 JSON 对象");
        const prompt = await options.projects.savePrompt(body.id, body.title, body.content);
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
      if (request.method === "GET" && url.pathname === "/api/v1/canvas/delivery-target") {
        send(response, 200, { ok: true, target: await project.delivery.readTarget() }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/canvas/delivery-target") {
        const body = await readJson(request);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "正式交接目录请求必须是 JSON 对象");
        send(response, 200, { ok: true, target: await project.delivery.saveTarget(body.aiDirectory) }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/canvas/project") {
        send(response, 200, { ok: true, project: project.canvasProject.read() }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/canvas/project") {
        const body = await readJson(request, 8 * 1_048_576);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "画布项目保存请求必须是 JSON 对象");
        const saved = await project.canvasProject.save(body.project, body.forceSnapshot === true);
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
      const adoptCanvasAssetId = url.pathname.match(/^\/api\/v1\/canvas\/assets\/([^/]+)\/adopt$/)?.[1];
      if (request.method === "POST" && adoptCanvasAssetId) {
        const body = await readJson(request);
        if (!isRecord(body)) throw new ProtocolError("INVALID_INPUT", "正式归档请求必须是 JSON 对象");
        const adoption = await project.delivery.adopt(decodeURIComponent(adoptCanvasAssetId), {
          viewpointName: body.viewpointName,
          stage: body.stage,
          taskId: body.taskId,
          versionId: body.versionId
        });
        send(response, adoption.deduplicated ? 200 : 201, { ok: true, adoption }); return;
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

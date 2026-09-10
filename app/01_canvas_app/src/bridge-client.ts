import type {
  CanvasImageAsset,
  CreateTaskInput,
  ExportRecord,
  GenerationTask,
  ProjectFolderImportResult,
  ProjectFolderManifest
} from "@gpt-canvas/shared";
import type { CanvasProjectDocument } from "./project-state";
import type { CanvasBatchRun, WorkflowStage } from "./project-state";

const BRIDGE_BASE_URL = (import.meta.env.VITE_BRIDGE_BASE_URL as string | undefined)?.replace(/\/$/, "")
  ?? "http://127.0.0.1:3220";

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

export class BridgeApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "BridgeApiError";
    this.code = code;
    this.status = status;
  }
}

export interface WorkbenchProject {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  imageNodes: number;
  annotations: number;
  relativeLocation: string;
  requirements: {
    sourceName: string;
    importedAt: string;
    title: string;
    summary: string;
    sectionCount: number;
  } | null;
}

export interface ProjectRequirementSection {
  key: string;
  label: string;
  heading: string;
  content: string;
}

export interface ProjectRequirementsPreview {
  sourceName: string;
  title: string;
  projectNameSuggestion: string;
  summary: string;
  generationContext: string;
  characterCount: number;
  recognizedSectionCount: number;
  sections: ProjectRequirementSection[];
  missingRecommended: string[];
}

export interface ActiveProjectRequirements {
  sourceName: string;
  importedAt: string;
  title: string;
  summary: string;
  generationContext: string;
  content?: string;
  sections: ProjectRequirementSection[];
}

export interface PromptLibraryItem {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryTarget {
  schemaVersion: "2.0";
  targetDirectory: string;
  configuredAt: string;
  updatedAt: string;
}

export interface FinalGlassBatchExport {
  targetDirectory: string;
  records: ExportRecord[];
  exported: number;
  deduplicated: number;
  failed: number;
  completed: boolean;
  logRelativePath: string;
}

export interface CodexCanvasCapabilities {
  schemaVersion: "1.0";
  bridgeVersion: string;
  pluginProtocolVersion: string;
  activeProjectId: string;
  canvasProjectLoaded: boolean;
  canvasRevision: number | null;
  sourcePolicy: "read-only-copy-import";
  supportedStages: Array<Exclude<WorkflowStage, "completed">>;
  supportedTools: string[];
  automaticFinalSelection: false;
  arbitraryFileWrite: false;
  arbitraryCommandExecution: false;
}

let sessionToken: string | null = null;

async function apiError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => ({})) as ApiErrorBody;
  return new BridgeApiError(
    body.error?.message || `本地文件服务返回 ${response.status}`,
    body.error?.code || "UNKNOWN",
    response.status
  );
}

export async function connectCanvasSession(): Promise<string> {
  const response = await fetch(`${BRIDGE_BASE_URL}/api/v1/canvas/session`, {
    method: "GET",
    cache: "no-store"
  });
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as { token?: unknown };
  if (typeof body.token !== "string" || !body.token) throw new Error("本地文件服务未返回有效会话");
  sessionToken = body.token;
  return sessionToken;
}

export async function getCurrentBridgeToken(): Promise<string> {
  return connectCanvasSession();
}

async function authenticatedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!sessionToken) await connectCanvasSession();
  return fetch(`${BRIDGE_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      "x-bridge-token": sessionToken ?? ""
    },
    cache: "no-store"
  });
}

export async function listWorkbenchProjects(): Promise<{
  projects: WorkbenchProject[];
  activeProjectId: string | null;
}> {
  const response = await authenticatedFetch("/api/v1/workbench/projects");
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as {
    projects?: WorkbenchProject[];
    activeProjectId?: string | null;
  };
  return {
    projects: body.projects ?? [],
    activeProjectId: body.activeProjectId ?? null
  };
}

export async function previewProjectRequirements(file: File): Promise<{
  content: string;
  preview: ProjectRequirementsPreview;
}> {
  if (file.size > 1_048_576) throw new Error("项目需求 Markdown 不得超过 1 MiB");
  const content = await file.text();
  const response = await authenticatedFetch("/api/v1/workbench/requirements/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceName: file.name, content })
  });
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as { preview?: ProjectRequirementsPreview };
  if (!body.preview) throw new Error("本地服务未返回项目需求提取结果");
  return { content, preview: body.preview };
}

export async function createWorkbenchProject(
  name: string,
  requirements?: { sourceName: string; content: string }
): Promise<WorkbenchProject> {
  const response = await authenticatedFetch("/api/v1/workbench/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, requirements })
  });
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as { project?: WorkbenchProject };
  if (!body.project) throw new Error("本地服务未返回新项目");
  return body.project;
}

export async function readActiveProjectRequirements(): Promise<ActiveProjectRequirements | null> {
  const response = await authenticatedFetch("/api/v1/canvas/project-requirements");
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as { requirements?: ActiveProjectRequirements | null };
  return body.requirements ?? null;
}

export async function updateActiveProjectRequirements(
  content: string
): Promise<ActiveProjectRequirements> {
  const response = await authenticatedFetch("/api/v1/canvas/project-requirements", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content })
  });
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as { requirements?: ActiveProjectRequirements };
  if (!body.requirements) throw new Error("本地服务未返回更新后的项目背景");
  return body.requirements;
}

export async function readDeliveryTarget(): Promise<DeliveryTarget | null> {
  const response = await authenticatedFetch("/api/v1/canvas/delivery-target");
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as { target?: DeliveryTarget | null };
  return body.target ?? null;
}

export async function saveDeliveryTarget(targetDirectory: string): Promise<DeliveryTarget> {
  const response = await authenticatedFetch("/api/v1/canvas/delivery-target", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetDirectory })
  });
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as { target?: DeliveryTarget };
  if (!body.target) throw new Error("本地服务未返回批量导出目录");
  return body.target;
}

export async function exportFinalGlassSelections(selections: readonly {
  assetId: string;
  versionId: string;
  viewpointName: string;
}[]): Promise<FinalGlassBatchExport> {
  const response = await authenticatedFetch("/api/v1/canvas/final-glass/batch-export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ selections })
  });
  if (!response.ok && response.status !== 207) throw await apiError(response);
  const body = await response.json() as { export?: FinalGlassBatchExport };
  if (!body.export) throw new Error("本地服务未返回最终玻璃批量导出结果");
  return body.export;
}

export async function activateWorkbenchProject(projectId: string): Promise<WorkbenchProject> {
  const response = await authenticatedFetch(
    `/api/v1/workbench/projects/${encodeURIComponent(projectId)}/activate`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
  );
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as { project?: WorkbenchProject };
  if (!body.project) throw new Error("本地服务未返回已选择项目");
  return body.project;
}

export async function deleteWorkbenchProject(projectId: string): Promise<{
  id: string;
  name: string;
  trashRelativeLocation: string;
}> {
  const response = await authenticatedFetch(
    `/api/v1/workbench/projects/${encodeURIComponent(projectId)}/delete`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
  );
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as {
    deleted?: { id: string; name: string; trashRelativeLocation: string };
  };
  if (!body.deleted) throw new Error("本地服务未返回项目删除结果");
  return body.deleted;
}

export async function listPromptLibrary(): Promise<PromptLibraryItem[]> {
  const response = await authenticatedFetch("/api/v1/workbench/prompts");
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as { prompts?: PromptLibraryItem[] };
  return Array.isArray(body.prompts) ? body.prompts : [];
}

export async function savePromptLibraryItem(
  title: string,
  content: string,
  id?: string
): Promise<PromptLibraryItem> {
  const response = await authenticatedFetch("/api/v1/workbench/prompts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, title, content })
  });
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as { prompt?: PromptLibraryItem };
  if (!body.prompt) throw new Error("本地服务未返回提示词");
  return body.prompt;
}

export async function deletePromptLibraryItem(id: string): Promise<void> {
  const response = await authenticatedFetch(
    `/api/v1/workbench/prompts/${encodeURIComponent(id)}/delete`,
    { method: "POST", body: "{}" }
  );
  if (!response.ok) throw await apiError(response);
}

export async function importCanvasAsset(
  file: File,
  dataUrl: string
): Promise<{ asset: CanvasImageAsset; deduplicated: boolean }> {
  const response = await authenticatedFetch("/api/v1/canvas/assets", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ name: file.name, dataUrl })
  });
  if (!response.ok) throw await apiError(response);
  return response.json() as Promise<{ asset: CanvasImageAsset; deduplicated: boolean }>;
}

export async function saveAnnotationExport(
  name: string,
  dataUrl: string
): Promise<{ asset: CanvasImageAsset; deduplicated: boolean }> {
  const response = await authenticatedFetch("/api/v1/canvas/annotation-exports", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ name, dataUrl })
  });
  if (!response.ok) throw await apiError(response);
  return response.json() as Promise<{ asset: CanvasImageAsset; deduplicated: boolean }>;
}

export async function saveGeneratedAsset(
  name: string,
  dataUrl: string
): Promise<{ asset: CanvasImageAsset; deduplicated: boolean }> {
  const response = await authenticatedFetch("/api/v1/canvas/generated-assets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, dataUrl })
  });
  if (!response.ok) throw await apiError(response);
  return response.json() as Promise<{ asset: CanvasImageAsset; deduplicated: boolean }>;
}

export async function downloadOriginalAsset(assetId: string, originalName: string): Promise<void> {
  const response = await authenticatedFetch(`/api/v1/canvas/assets/${encodeURIComponent(assetId)}/original`);
  if (!response.ok) throw await apiError(response);
  const blob = await response.blob();
  if (!blob.size) throw new Error("原图文件为空，无法下载");
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = originalName;
  anchor.style.display = "none";
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

export async function createGenerationTask(input: CreateTaskInput): Promise<GenerationTask> {
  const response = await authenticatedFetch("/api/v1/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as { task?: GenerationTask };
  if (!body.task) throw new Error("桥接服务未返回任务");
  return body.task;
}

export async function readGenerationTask(taskId: string): Promise<GenerationTask> {
  const response = await authenticatedFetch(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as { task?: GenerationTask };
  if (!body.task) throw new Error("桥接服务未返回任务状态");
  return body.task;
}

export async function readActiveGenerationTask(): Promise<GenerationTask | null> {
  const response = await authenticatedFetch("/api/v1/tasks/active");
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as { task?: GenerationTask | null };
  return body.task ?? null;
}

export async function cancelGenerationTask(taskId: string): Promise<GenerationTask> {
  const response = await authenticatedFetch(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/status`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "cancelled",
        by: "user",
        note: "用户从画布结束本地任务"
      })
    }
  );
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as { task?: GenerationTask };
  if (!body.task) throw new Error("本地服务未返回已取消任务");
  return body.task;
}

export async function readGenerationResultAsDataUrl(taskId: string, resultId: string): Promise<string> {
  const response = await authenticatedFetch(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/results/${encodeURIComponent(resultId)}`
  );
  if (!response.ok) throw await apiError(response);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取生成结果"));
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error("无法读取生成结果"));
    reader.readAsDataURL(blob);
  });
}

export async function listCanvasAssets(): Promise<CanvasImageAsset[]> {
  const response = await authenticatedFetch("/api/v1/canvas/assets");
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as { assets?: CanvasImageAsset[] };
  return body.assets ?? [];
}

export async function scanProjectFolder(
  sourceRoot: string,
  includeSubfolders = false
): Promise<ProjectFolderManifest> {
  const response = await authenticatedFetch("/api/v1/canvas/folder-manifests/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceRoot, includeSubfolders })
  });
  if (!response.ok) throw await apiError(response);
  return (await response.json() as { manifest: ProjectFolderManifest }).manifest;
}

export async function selectProjectFolder(): Promise<string | null> {
  const response = await authenticatedFetch("/api/v1/canvas/folder-manifests/select-folder", {
    method: "POST"
  });
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as { sourceRoot?: string | null };
  return typeof body.sourceRoot === "string" && body.sourceRoot.trim() ? body.sourceRoot : null;
}

export async function readProjectFolderManifest(id: string): Promise<ProjectFolderManifest> {
  const response = await authenticatedFetch(`/api/v1/canvas/folder-manifests/${encodeURIComponent(id)}`);
  if (!response.ok) throw await apiError(response);
  return (await response.json() as { manifest: ProjectFolderManifest }).manifest;
}

export async function importProjectFolderManifest(
  id: string,
  selectedRelativePaths?: readonly string[]
): Promise<ProjectFolderImportResult> {
  const response = await authenticatedFetch(`/api/v1/canvas/folder-manifests/${encodeURIComponent(id)}/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(selectedRelativePaths ? { selectedRelativePaths } : {}) })
  });
  const body = await response.json().catch(() => ({})) as {
    error?: { message?: string };
    import?: ProjectFolderImportResult;
  };
  if (!response.ok && response.status !== 207) {
    throw new Error(body.error?.message || `本地文件服务返回 ${response.status}`);
  }
  if (!body.import) throw new Error("本地文件服务未返回导入结果");
  return body.import;
}

export async function readCodexCanvasCapabilities(): Promise<CodexCanvasCapabilities> {
  const response = await authenticatedFetch("/api/v1/canvas/codex-capabilities");
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as { capabilities?: CodexCanvasCapabilities };
  if (!body.capabilities) throw new Error("本地服务未返回 Codex 能力信息");
  return body.capabilities;
}

export async function createCodexCanvasRun(input: {
  authorizationId: string;
  manifestId?: string;
  sourceFolder: string | null;
  stage: Exclude<WorkflowStage, "completed">;
  action: "analyze" | "prompt" | "generate";
  sourceVersionIds: readonly `version_${string}`[];
  styleReferenceVersionId?: `version_${string}` | null;
  prompt?: string;
  maximumGenerations: number;
  allowManualFallback: boolean;
  stopOnStructureRisk: boolean;
  approvedAt: string;
  confirmed: true;
}): Promise<{
  project: CanvasProjectDocument;
  run: CanvasBatchRun;
  snapshotRelativePath: string | null;
  deduplicated: boolean;
}> {
  const response = await authenticatedFetch("/api/v1/canvas/codex-runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw await apiError(response);
  return response.json() as Promise<{
    project: CanvasProjectDocument;
    run: CanvasBatchRun;
    snapshotRelativePath: string | null;
    deduplicated: boolean;
  }>;
}

export async function transitionCodexCanvasRun(
  runId: string,
  action: "pause" | "resume"
): Promise<{ project: CanvasProjectDocument; run: CanvasBatchRun; snapshotRelativePath: string | null }> {
  const response = await authenticatedFetch(
    `/api/v1/canvas/codex-runs/${encodeURIComponent(runId)}/${action}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
  );
  if (!response.ok) throw await apiError(response);
  return response.json() as Promise<{
    project: CanvasProjectDocument;
    run: CanvasBatchRun;
    snapshotRelativePath: string | null;
  }>;
}

export async function handoffCanvasRun(
  runId: string,
  targetRunner: "manual" | "codex",
  reason: string
): Promise<{ project: CanvasProjectDocument; run: CanvasBatchRun; snapshotRelativePath: string | null }> {
  const response = await authenticatedFetch(
    `/api/v1/canvas/codex-runs/${encodeURIComponent(runId)}/handoff`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetRunner, reason, confirmed: true })
    }
  );
  if (!response.ok) throw await apiError(response);
  return response.json() as Promise<{
    project: CanvasProjectDocument;
    run: CanvasBatchRun;
    snapshotRelativePath: string | null;
  }>;
}

export async function readCanvasAssetAsDataUrl(
  assetId: string,
  rendition: "original" | "display" | "thumbnail" = "original"
): Promise<string> {
  const response = await authenticatedFetch(
    `/api/v1/canvas/assets/${encodeURIComponent(assetId)}/${rendition}`
  );
  if (!response.ok) throw await apiError(response);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取画布资产"));
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error("无法读取画布资产"));
    reader.readAsDataURL(blob);
  });
}

const managedCanvasObjectUrls = new Set<string>();

export async function readCanvasAssetAsObjectUrl(
  assetId: string,
  rendition: "original" | "display" | "thumbnail" = "display"
): Promise<string> {
  const response = await authenticatedFetch(
    `/api/v1/canvas/assets/${encodeURIComponent(assetId)}/${rendition}`
  );
  if (!response.ok) throw await apiError(response);
  const url = URL.createObjectURL(await response.blob());
  managedCanvasObjectUrls.add(url);
  return url;
}

export function releaseCanvasAssetObjectUrl(url: string): void {
  if (!managedCanvasObjectUrls.delete(url)) return;
  URL.revokeObjectURL(url);
}

export function releaseAllCanvasAssetObjectUrls(): void {
  for (const url of managedCanvasObjectUrls) URL.revokeObjectURL(url);
  managedCanvasObjectUrls.clear();
}

export async function saveCanvasAssetDerivatives(
  assetId: string,
  displayDataUrl: string,
  thumbnailDataUrl: string
): Promise<{ asset: CanvasImageAsset; deduplicated: boolean }> {
  const response = await authenticatedFetch(
    `/api/v1/canvas/assets/${encodeURIComponent(assetId)}/derivatives`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayDataUrl, thumbnailDataUrl })
    }
  );
  if (!response.ok) throw await apiError(response);
  return response.json() as Promise<{ asset: CanvasImageAsset; deduplicated: boolean }>;
}

export async function readCanvasProject(): Promise<CanvasProjectDocument | null> {
  const response = await authenticatedFetch("/api/v1/canvas/project");
  if (!response.ok) throw await apiError(response);
  const body = await response.json() as { project?: CanvasProjectDocument | null };
  return body.project ?? null;
}

export async function saveCanvasProject(
  project: CanvasProjectDocument,
  forceSnapshot = false
): Promise<{ project: CanvasProjectDocument; snapshotRelativePath: string | null }> {
  const response = await authenticatedFetch("/api/v1/canvas/project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project, forceSnapshot })
  });
  if (!response.ok) throw await apiError(response);
  return response.json() as Promise<{
    project: CanvasProjectDocument;
    snapshotRelativePath: string | null;
  }>;
}

export async function preserveCanvasConflictDraft(
  project: CanvasProjectDocument
): Promise<{
  currentProject: CanvasProjectDocument;
  conflictRelativePath: string;
}> {
  const response = await authenticatedFetch("/api/v1/canvas/project/conflict-draft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project })
  });
  if (!response.ok) throw await apiError(response);
  return response.json() as Promise<{
    currentProject: CanvasProjectDocument;
    conflictRelativePath: string;
  }>;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取图片：${file.name}`));
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error(`无法读取图片：${file.name}`));
    reader.readAsDataURL(file);
  });
}

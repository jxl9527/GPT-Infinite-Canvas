import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { ProtocolError } from "@gpt-canvas/shared";
import { CanvasAssetRepository } from "./canvas-asset-repository.js";
import { CanvasProjectRepository } from "./canvas-project-repository.js";
import { DiagnosticLogger } from "./diagnostics.js";
import { DeliveryRepository } from "./delivery-repository.js";
import {
  parseProjectRequirements,
  type ProjectRequirementsPreview
} from "./project-requirements.js";
import { ResultRepository } from "./result-repository.js";
import { TaskStore } from "./task-store.js";
import { ProjectFolderManifestService } from "./project-folder-manifest.js";

const LEGACY_PROJECT_ID = "project_default";
const PROJECT_ID_PATTERN = /^project_[a-f0-9-]{36}$/;

interface ProjectMetadata {
  schemaVersion: "1.0";
  id: string;
  name: string;
  createdAt: string;
  requirements?: ProjectRequirementsReference;
}

interface ProjectRequirementsReference {
  sourceName: string;
  sourceRelativePath: string;
  contextRelativePath: string;
  generationContextRelativePath: string;
  sha256: string;
  importedAt: string;
  title: string;
  summary: string;
  sectionCount: number;
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

export interface DeletedWorkbenchProject {
  id: string;
  name: string;
  trashRelativeLocation: string;
}

export interface PromptLibraryItem {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  category?: string;
  inputHint?: string;
  coverDataUrl?: string;
  coverLabel?: string;
  version?: number;
}

export interface ProjectRuntimeContext {
  id: string;
  name: string;
  projectRoot: string;
  store: TaskStore;
  canvasAssets: CanvasAssetRepository;
  canvasProject: CanvasProjectRepository;
  diagnostics: DiagnosticLogger;
  results: ResultRepository;
  delivery: DeliveryRepository;
  folderManifests: ProjectFolderManifestService;
}

export interface ActiveProjectRequirements {
  sourceName: string;
  importedAt: string;
  title: string;
  summary: string;
  generationContext: string;
  content: string;
  sections: ProjectRequirementsPreview["sections"];
}

interface ProjectRecord {
  metadata: ProjectMetadata;
  projectRoot: string;
  relativeLocation: string;
}

function normalizeProjectName(value: unknown): string {
  if (typeof value !== "string") throw new ProtocolError("INVALID_INPUT", "项目名称不能为空");
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > 40) throw new ProtocolError("INVALID_INPUT", "项目名称须为 1–40 个字符");
  if (/[\u0000-\u001f<>:"/\\|?*]/.test(name)) throw new ProtocolError("INVALID_INPUT", "项目名称包含 Windows 不支持的字符");
  return name;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function activeCodexBatchStatus(context: ProjectRuntimeContext | null): string | null {
  const project = context?.canvasProject.read();
  if (!project || typeof project.workflow !== "object" || project.workflow === null || Array.isArray(project.workflow)) return null;
  const batchRun = (project.workflow as Record<string, unknown>).batchRun;
  if (!batchRun || typeof batchRun !== "object" || Array.isArray(batchRun)) return null;
  const run = batchRun as Record<string, unknown>;
  return run.runner === "codex" && typeof run.status === "string" ? run.status : null;
}

export class ProjectRuntimeManager {
  private readonly projectsRoot: string;
  private readonly systemDiagnostics: DiagnosticLogger;
  private readonly promptLibraryPath: string;
  private prompts: PromptLibraryItem[] = [];
  private promptQueue: Promise<void> = Promise.resolve();
  private active: ProjectRuntimeContext | null = null;

  constructor(readonly runtimeRoot: string, readonly legacyProjectRoot: string) {
    this.projectsRoot = resolve(runtimeRoot, "projects");
    this.systemDiagnostics = new DiagnosticLogger(resolve(runtimeRoot, "workbench"));
    this.promptLibraryPath = resolve(runtimeRoot, "workbench", "prompt-library.json");
  }

  async init(): Promise<void> {
    await mkdir(this.runtimeRoot, { recursive: true });
    await mkdir(this.projectsRoot, { recursive: true });
    await this.systemDiagnostics.init();
    const library = await readJson(this.promptLibraryPath);
    this.prompts = Array.isArray(library?.prompts)
      ? library.prompts.filter((item): item is PromptLibraryItem => (
        typeof item === "object"
        && item !== null
        && typeof (item as PromptLibraryItem).id === "string"
        && typeof (item as PromptLibraryItem).title === "string"
        && typeof (item as PromptLibraryItem).content === "string"
        && typeof (item as PromptLibraryItem).createdAt === "string"
        && typeof (item as PromptLibraryItem).updatedAt === "string"
      ))
      : [];
  }

  current(): ProjectRuntimeContext | null {
    return this.active;
  }

  diagnostics(): DiagnosticLogger {
    return this.active?.diagnostics ?? this.systemDiagnostics;
  }

  listPrompts(): PromptLibraryItem[] {
    return [...this.prompts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async savePrompt(idValue: unknown, titleValue: unknown, contentValue: unknown, metadata?: Record<string, unknown>): Promise<PromptLibraryItem> {
    const operation = this.promptQueue.then(() => this.savePromptInternal(idValue, titleValue, contentValue, metadata));
    this.promptQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async savePromptInternal(idValue: unknown, titleValue: unknown, contentValue: unknown, metadata?: Record<string, unknown>): Promise<PromptLibraryItem> {
    const title = typeof titleValue === "string" ? titleValue.trim().replace(/\s+/g, " ") : "";
    const content = typeof contentValue === "string" ? contentValue.trim() : "";
    if (!title || title.length > 40) throw new ProtocolError("INVALID_INPUT", "提示词名称须为 1–40 个字符");
    if (!content || content.length > 20_000) throw new ProtocolError("INVALID_INPUT", "提示词内容须为 1–20000 个字符");
    const extras: Partial<PromptLibraryItem> = {};
    for (const key of ["category", "inputHint", "coverLabel"] as const) {
      const value = metadata?.[key];
      if (value !== undefined) {
        if (typeof value !== "string" || value.length > 200) throw new ProtocolError("INVALID_INPUT", `${key} 无效`);
        extras[key] = value;
      }
    }
    if (metadata?.coverDataUrl !== undefined) {
      if (typeof metadata.coverDataUrl !== "string" || metadata.coverDataUrl.length > 2_800_000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(metadata.coverDataUrl)) throw new ProtocolError("INVALID_INPUT", "封面须为不超过 2 MiB 的 PNG、JPEG 或 WebP");
      extras.coverDataUrl = metadata.coverDataUrl;
    }
    const existing = typeof idValue === "string"
      ? this.prompts.find((item) => item.id === idValue)
      : undefined;
    const now = new Date().toISOString();
    const item: PromptLibraryItem = existing
      ? { ...existing, title, content, updatedAt: now }
      : {
        id: `prompt_${randomUUID()}`,
        title,
        content,
        createdAt: now,
        updatedAt: now
      };
    Object.assign(item, extras, { version: (existing?.version ?? 0) + 1 });
    const previous = this.prompts;
    this.prompts = existing
      ? this.prompts.map((candidate) => candidate.id === item.id ? item : candidate)
      : [...this.prompts, item];
    try { await this.writePromptLibrary(); } catch (error) { this.prompts = previous; throw error; }
    return item;
  }

  async deletePrompt(idValue: string): Promise<void> {
    const operation = this.promptQueue.then(() => this.deletePromptInternal(idValue));
    this.promptQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async deletePromptInternal(idValue: string): Promise<void> {
    const id = decodeURIComponent(idValue);
    if (!/^prompt_[a-f0-9-]{36}$/.test(id)) throw new ProtocolError("INVALID_INPUT", "提示词编号无效");
    const next = this.prompts.filter((item) => item.id !== id);
    if (next.length === this.prompts.length) throw new ProtocolError("TASK_NOT_FOUND", "提示词不存在");
    const previous = this.prompts;
    this.prompts = next;
    try { await this.writePromptLibrary(); } catch (error) { this.prompts = previous; throw error; }
  }

  async list(): Promise<WorkbenchProject[]> {
    const records = await this.records();
    return Promise.all(records.map(async (record) => {
      const project = await readJson(join(record.projectRoot, "canvas", "project.json"));
      const nodes = project && typeof project.canvas === "object" && project.canvas !== null
        && Array.isArray((project.canvas as { nodes?: unknown }).nodes)
        ? (project.canvas as { nodes: Array<{ type?: unknown }> }).nodes
        : [];
      return {
        id: record.metadata.id,
        name: record.metadata.name,
        createdAt: record.metadata.createdAt,
        updatedAt: typeof project?.updatedAt === "string" ? project.updatedAt : record.metadata.createdAt,
        revision: typeof project?.revision === "number" ? project.revision : 0,
        imageNodes: nodes.filter((node) => node.type === "image").length,
        annotations: nodes.filter((node) => node.type !== "image").length,
        relativeLocation: record.relativeLocation,
        requirements: record.metadata.requirements
          ? {
            sourceName: record.metadata.requirements.sourceName,
            importedAt: record.metadata.requirements.importedAt,
            title: record.metadata.requirements.title,
            summary: record.metadata.requirements.summary,
            sectionCount: record.metadata.requirements.sectionCount
          }
          : null
      };
    }));
  }

  previewRequirements(sourceNameValue: unknown, contentValue: unknown): ProjectRequirementsPreview {
    return parseProjectRequirements(sourceNameValue, contentValue).preview;
  }

  async create(nameValue: unknown, requirementsValue: unknown): Promise<WorkbenchProject> {
    const name = normalizeProjectName(nameValue);
    let parsed: ReturnType<typeof parseProjectRequirements> | null = null;
    if (requirementsValue !== undefined && requirementsValue !== null) {
      if (typeof requirementsValue !== "object" || Array.isArray(requirementsValue)) {
        throw new ProtocolError("INVALID_INPUT", "项目需求必须是 Markdown 文件内容");
      }
      const requirementsRecord = requirementsValue as Record<string, unknown>;
      parsed = parseProjectRequirements(requirementsRecord.sourceName, requirementsRecord.content);
    }
    const id = `project_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const projectRoot = resolve(this.projectsRoot, id);
    if (basename(projectRoot) !== id || !PROJECT_ID_PATTERN.test(id)) {
      throw new ProtocolError("INVALID_INPUT", "新项目目录无效");
    }
    const stagingRoot = resolve(this.projectsRoot, `${id}.creating-${randomUUID()}`);
    if (basename(stagingRoot) !== stagingRoot.slice(stagingRoot.lastIndexOf("\\") + 1)) {
      throw new ProtocolError("INVALID_INPUT", "新项目临时目录无效");
    }
    const importedAt = createdAt;
    const sourceRelativePath = "inputs/requirements/项目需求_v1.md";
    const contextRelativePath = "context/project-context.json";
    const generationContextRelativePath = "context/generation-context.md";
    const requirementsReference: ProjectRequirementsReference | null = parsed
      ? {
          sourceName: parsed.preview.sourceName,
          sourceRelativePath,
          contextRelativePath,
          generationContextRelativePath,
          sha256: createHash("sha256").update(parsed.content, "utf8").digest("hex"),
          importedAt,
          title: parsed.preview.title,
          summary: parsed.preview.summary,
          sectionCount: parsed.preview.recognizedSectionCount
        }
      : null;
    const metadata: ProjectMetadata = {
      schemaVersion: "1.0",
      id,
      name,
      createdAt
    };
    if (requirementsReference) metadata.requirements = requirementsReference;
    try {
      await mkdir(join(stagingRoot, "logs"), { recursive: true });
      if (parsed && requirementsReference) {
        await mkdir(join(stagingRoot, "inputs", "requirements"), { recursive: true });
        await mkdir(join(stagingRoot, "context"), { recursive: true });
        await writeFile(join(stagingRoot, sourceRelativePath), parsed.content, { encoding: "utf8", flag: "wx" });
        await writeFile(
          join(stagingRoot, contextRelativePath),
          `${JSON.stringify({
            schemaVersion: "1.0",
            sourceName: parsed.preview.sourceName,
            importedAt,
            title: parsed.preview.title,
            projectName: name,
            summary: parsed.preview.summary,
            generationContext: parsed.preview.generationContext,
            sections: parsed.preview.sections,
            missingRecommended: parsed.preview.missingRecommended
          }, null, 2)}\n`,
          { encoding: "utf8", flag: "wx" }
        );
        await writeFile(
          join(stagingRoot, generationContextRelativePath),
          `${parsed.preview.generationContext}\n`,
          { encoding: "utf8", flag: "wx" }
        );
        await writeFile(
          join(stagingRoot, "logs", "requirements-import.ndjson"),
          `${JSON.stringify({
            at: importedAt,
            action: "requirements-imported",
            sourceName: parsed.preview.sourceName,
            sha256: requirementsReference.sha256,
            recognizedSectionCount: parsed.preview.recognizedSectionCount
          })}\n`,
          { encoding: "utf8", flag: "wx" }
        );
      }
      await writeFile(
        join(stagingRoot, "project-meta.json"),
        `${JSON.stringify(metadata, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" }
      );
      await rename(stagingRoot, projectRoot);
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return {
      id,
      name,
      createdAt,
      updatedAt: createdAt,
      revision: 0,
      imageNodes: 0,
      annotations: 0,
      relativeLocation: `projects/${id}`,
      requirements: requirementsReference
        ? {
            sourceName: requirementsReference.sourceName,
            importedAt,
            title: requirementsReference.title,
            summary: requirementsReference.summary,
            sectionCount: requirementsReference.sectionCount
          }
        : null
    };
  }

  async deleteProject(idValue: unknown): Promise<DeletedWorkbenchProject> {
    if (typeof idValue !== "string" || !PROJECT_ID_PATTERN.test(idValue)) {
      if (idValue === LEGACY_PROJECT_ID) {
        throw new ProtocolError("INVALID_INPUT", "原有项目是兼容入口，不能在工作台中删除");
      }
      throw new ProtocolError("INVALID_INPUT", "项目编号无效");
    }
    if (this.active?.id === idValue && this.active.store.getActive()) {
      throw new ProtocolError("TASK_LOCKED", "当前项目仍有生成任务，结束任务后才能删除项目");
    }
    const codexBatchStatus = this.active?.id === idValue ? activeCodexBatchStatus(this.active) : null;
    if (codexBatchStatus && codexBatchStatus !== "completed") {
      throw new ProtocolError("TASK_LOCKED", "当前项目仍有未完成的 Codex 批次，完成批次后才能删除项目");
    }
    const record = (await this.records()).find((candidate) => candidate.metadata.id === idValue);
    if (!record) throw new ProtocolError("TASK_NOT_FOUND", "准备删除的项目不存在");
    const expectedRoot = resolve(this.projectsRoot, idValue);
    if (record.projectRoot !== expectedRoot || basename(record.projectRoot) !== idValue) {
      throw new ProtocolError("INVALID_INPUT", "项目目录不在可删除范围内");
    }
    const trashRoot = resolve(this.runtimeRoot, "trash", "projects");
    await mkdir(trashRoot, { recursive: true });
    const trashName = `${idValue}.deleted-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const trashPath = resolve(trashRoot, trashName);
    if (basename(trashPath) !== trashName) throw new ProtocolError("INVALID_INPUT", "项目回收路径无效");
    await rename(record.projectRoot, trashPath);
    if (this.active?.id === idValue) this.active = null;
    await this.systemDiagnostics.log({
      event: "project-moved-to-trash",
      message: `${idValue} -> trash/projects/${trashName}`
    });
    return {
      id: idValue,
      name: record.metadata.name,
      trashRelativeLocation: `trash/projects/${trashName}`
    };
  }

  async activeRequirements(): Promise<ActiveProjectRequirements | null> {
    const current = this.active;
    if (!current) return null;
    const record = (await this.records()).find((candidate) => candidate.metadata.id === current.id);
    if (!record?.metadata.requirements) return null;
    const context = await readJson(join(record.projectRoot, record.metadata.requirements.contextRelativePath));
    if (
      !context
      || typeof context.sourceName !== "string"
      || typeof context.importedAt !== "string"
      || typeof context.title !== "string"
      || typeof context.summary !== "string"
      || typeof context.generationContext !== "string"
      || !Array.isArray(context.sections)
    ) {
      throw new ProtocolError("INVALID_INPUT", "项目需求上下文文件损坏，请从项目工作台重新创建项目");
    }
    return {
      sourceName: context.sourceName,
      importedAt: context.importedAt,
      title: context.title,
      summary: context.summary,
      generationContext: context.generationContext,
      content: await readFile(join(record.projectRoot, record.metadata.requirements.sourceRelativePath), "utf8"),
      sections: context.sections as ProjectRequirementsPreview["sections"]
    };
  }

  async saveActiveRequirements(contentValue: unknown): Promise<ActiveProjectRequirements> {
    const current = this.active;
    if (!current) throw new ProtocolError("TASK_LOCKED", "请先选择项目");
    const record = (await this.records()).find((candidate) => candidate.metadata.id === current.id);
    if (!record?.metadata.requirements) {
      throw new ProtocolError("INVALID_INPUT", "当前项目没有可编辑的项目背景");
    }

    const parsed = parseProjectRequirements(record.metadata.requirements.sourceName, contentValue);
    const requirementFiles = await readdir(join(record.projectRoot, "inputs", "requirements"));
    const version = Math.max(
      1,
      ...requirementFiles.map((name) => Number(name.match(/^项目需求_v(\d+)\.md$/)?.[1] ?? 0))
    ) + 1;
    const importedAt = new Date().toISOString();
    const sourceRelativePath = `inputs/requirements/项目需求_v${version}.md`;
    const contextRelativePath = `context/project-context_v${version}.json`;
    const generationContextRelativePath = `context/generation-context_v${version}.md`;
    const nextReference: ProjectRequirementsReference = {
      sourceName: parsed.preview.sourceName,
      sourceRelativePath,
      contextRelativePath,
      generationContextRelativePath,
      sha256: createHash("sha256").update(parsed.content, "utf8").digest("hex"),
      importedAt,
      title: parsed.preview.title,
      summary: parsed.preview.summary,
      sectionCount: parsed.preview.recognizedSectionCount
    };
    const nextMetadata: ProjectMetadata = {
      ...record.metadata,
      requirements: nextReference
    };

    await mkdir(join(record.projectRoot, "backups"), { recursive: true });
    await writeFile(
      join(record.projectRoot, sourceRelativePath),
      parsed.content,
      { encoding: "utf8", flag: "wx" }
    );
    await writeFile(
      join(record.projectRoot, contextRelativePath),
      `${JSON.stringify({
        schemaVersion: "1.0",
        sourceName: parsed.preview.sourceName,
        importedAt,
        title: parsed.preview.title,
        projectName: record.metadata.name,
        summary: parsed.preview.summary,
        generationContext: parsed.preview.generationContext,
        sections: parsed.preview.sections,
        missingRecommended: parsed.preview.missingRecommended
      }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    await writeFile(
      join(record.projectRoot, generationContextRelativePath),
      `${parsed.preview.generationContext}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    await writeFile(
      join(record.projectRoot, "backups", `project-meta_before_requirements_v${version}.json`),
      `${JSON.stringify(record.metadata, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    await writeFile(
      join(record.projectRoot, "project-meta.json"),
      `${JSON.stringify(nextMetadata, null, 2)}\n`,
      { encoding: "utf8" }
    );
    await writeFile(
      join(record.projectRoot, "logs", "requirements-import.ndjson"),
      `${JSON.stringify({
        at: importedAt,
        action: "requirements-edited",
        sourceName: parsed.preview.sourceName,
        sourceRelativePath,
        sha256: nextReference.sha256,
        recognizedSectionCount: parsed.preview.recognizedSectionCount
      })}\n`,
      { encoding: "utf8", flag: "a" }
    );

    return {
      sourceName: parsed.preview.sourceName,
      importedAt,
      title: parsed.preview.title,
      summary: parsed.preview.summary,
      generationContext: parsed.preview.generationContext,
      content: parsed.content,
      sections: parsed.preview.sections
    };
  }

  async activate(id: string): Promise<ProjectRuntimeContext> {
    if (this.active?.id === id) return this.active;
    if (this.active?.store.getActive()) {
      throw new ProtocolError("TASK_LOCKED", "当前项目仍有生成任务，完成或人工接管后才能切换项目");
    }
    const codexBatchStatus = activeCodexBatchStatus(this.active);
    if (codexBatchStatus === "ready" || codexBatchStatus === "running") {
      throw new ProtocolError("TASK_LOCKED", "当前项目仍有活动的 Codex 批次，请先暂停或完成后再切换项目");
    }
    const record = (await this.records()).find((candidate) => candidate.metadata.id === id);
    if (!record) throw new ProtocolError("TASK_NOT_FOUND", "选择的项目不存在");
    const store = new TaskStore(record.projectRoot); await store.init();
    const canvasAssets = new CanvasAssetRepository(record.projectRoot); await canvasAssets.init();
    const canvasProject = new CanvasProjectRepository(record.projectRoot); await canvasProject.init();
    const diagnostics = new DiagnosticLogger(record.projectRoot); await diagnostics.init();
    const results = new ResultRepository(record.projectRoot, store);
    const delivery = new DeliveryRepository(record.projectRoot, canvasAssets, store, canvasProject); await delivery.init();
    const folderManifests = new ProjectFolderManifestService(record.projectRoot, canvasAssets); await folderManifests.init();
    this.active = {
      id: record.metadata.id,
      name: record.metadata.name,
      projectRoot: record.projectRoot,
      store,
      canvasAssets,
      canvasProject,
      diagnostics,
      results,
      delivery,
      folderManifests
    };
    return this.active;
  }

  private async writePromptLibrary(): Promise<void> {
    try {
      const previous = await readFile(this.promptLibraryPath, "utf8");
      JSON.parse(previous);
      const backups = resolve(this.runtimeRoot, "workbench", "prompt-library-history");
      await mkdir(backups, { recursive: true });
      await writeFile(resolve(backups, `${Date.now()}-${randomUUID()}.json`), previous, { encoding: "utf8", flag: "wx" });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = resolve(this.runtimeRoot, "workbench", `prompt-library.${randomUUID()}.tmp`);
    await writeFile(
      temporary,
      `${JSON.stringify({ schemaVersion: "1.0", prompts: this.prompts }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    await rename(temporary, this.promptLibraryPath);
  }

  private async records(): Promise<ProjectRecord[]> {
    const records: ProjectRecord[] = [];
    const legacyProject = await readJson(join(this.legacyProjectRoot, "canvas", "project.json"));
    const legacyRootExists = (await stat(this.legacyProjectRoot).catch(() => null))?.isDirectory() === true;
    if (legacyProject || legacyRootExists) {
      records.push({
        metadata: {
          schemaVersion: "1.0",
          id: LEGACY_PROJECT_ID,
          name: typeof legacyProject?.title === "string"
            && legacyProject.title.trim()
            && legacyProject.title.trim() !== "未命名项目"
            ? legacyProject.title.trim()
            : "原有项目",
          createdAt: typeof legacyProject?.createdAt === "string"
            ? legacyProject.createdAt
            : new Date(0).toISOString()
        },
        projectRoot: this.legacyProjectRoot,
        relativeLocation: "default-project"
      });
    }
    for (const entry of await readdir(this.projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !PROJECT_ID_PATTERN.test(entry.name)) continue;
      const projectRoot = resolve(this.projectsRoot, entry.name);
      const metadata = await readJson(join(projectRoot, "project-meta.json"));
      if (
        metadata?.schemaVersion !== "1.0"
        || metadata.id !== entry.name
        || typeof metadata.name !== "string"
        || typeof metadata.createdAt !== "string"
      ) continue;
      records.push({
        metadata: metadata as unknown as ProjectMetadata,
        projectRoot,
        relativeLocation: `projects/${entry.name}`
      });
    }
    return records.sort((left, right) => right.metadata.createdAt.localeCompare(left.metadata.createdAt));
  }
}

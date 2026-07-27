import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ProtocolError } from "@gpt-canvas/shared";

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new ProtocolError("INVALID_INPUT", `${field} 必须是数组`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ProtocolError("INVALID_INPUT", `${field} 无效`);
  return value;
}

function validateProject(value: unknown): JsonObject {
  if (!isRecord(value) || value.schemaVersion !== "1.0") {
    throw new ProtocolError("RECOVERY_REQUIRED", "画布项目 schemaVersion 无效");
  }
  if (!/^project_[0-9a-f-]{36}$/.test(requiredString(value.projectId, "projectId"))) {
    throw new ProtocolError("INVALID_INPUT", "projectId 无效");
  }
  requiredString(value.title, "title");
  if (!Number.isInteger(value.revision) || (value.revision as number) < 0) {
    throw new ProtocolError("INVALID_INPUT", "revision 无效");
  }
  if (!isRecord(value.canvas) || !isRecord(value.canvas.viewport)) {
    throw new ProtocolError("INVALID_INPUT", "canvas 或 viewport 无效");
  }
  const viewport = value.canvas.viewport;
  if (
    !Number.isFinite(viewport.x)
    || !Number.isFinite(viewport.y)
    || !Number.isFinite(viewport.scale)
    || (viewport.scale as number) <= 0
    || (viewport.scale as number) > 16
  ) {
    throw new ProtocolError("INVALID_INPUT", "viewport 数值无效");
  }
  const nodes = requiredArray(value.canvas.nodes, "canvas.nodes");
  const assets = requiredArray(value.assets, "assets");
  const versions = requiredArray(value.versions, "versions");
  const taskLinks = requiredArray(value.taskLinks, "taskLinks");
  const assetIds = new Set<string>();
  for (const asset of assets) {
    if (!isRecord(asset) || typeof asset.id !== "string" || !asset.id.startsWith("asset_")) {
      throw new ProtocolError("INVALID_INPUT", "图片资产记录无效");
    }
    if (assetIds.has(asset.id)) throw new ProtocolError("INVALID_INPUT", `图片资产重复：${asset.id}`);
    assetIds.add(asset.id);
  }
  const versionIds = new Set<string>();
  for (const version of versions) {
    if (
      !isRecord(version)
      || typeof version.id !== "string"
      || !version.id.startsWith("version_")
      || typeof version.assetId !== "string"
      || !assetIds.has(version.assetId)
    ) {
      throw new ProtocolError("RECOVERY_REQUIRED", "图片版本引用了不存在的资产");
    }
    if (versionIds.has(version.id)) throw new ProtocolError("INVALID_INPUT", `图片版本重复：${version.id}`);
    versionIds.add(version.id);
  }
  for (const version of versions) {
    if (isRecord(version) && version.parentVersionId !== null && !versionIds.has(String(version.parentVersionId))) {
      throw new ProtocolError("RECOVERY_REQUIRED", `父版本不存在：${String(version.parentVersionId)}`);
    }
  }
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (
      !isRecord(node)
      || typeof node.id !== "string"
      || !node.id.startsWith("node_")
      || !isRecord(node.payload)
    ) {
      throw new ProtocolError("INVALID_INPUT", "画布节点无效");
    }
    if (nodeIds.has(node.id)) throw new ProtocolError("INVALID_INPUT", `画布节点重复：${node.id}`);
    nodeIds.add(node.id);
    if (node.type === "image" && !versionIds.has(String(node.payload.imageVersionId))) {
      throw new ProtocolError("RECOVERY_REQUIRED", `图片节点引用了不存在的版本：${String(node.payload.imageVersionId)}`);
    }
  }
  for (const link of taskLinks) {
    if (!isRecord(link)) throw new ProtocolError("INVALID_INPUT", "taskLinks 记录无效");
    if (link.parentVersionId !== null && !versionIds.has(String(link.parentVersionId))) {
      throw new ProtocolError("RECOVERY_REQUIRED", "任务父版本不存在");
    }
    for (const resultVersionId of requiredArray(link.resultVersionIds, "taskLink.resultVersionIds")) {
      if (!versionIds.has(String(resultVersionId))) throw new ProtocolError("RECOVERY_REQUIRED", "任务结果版本不存在");
    }
  }
  return structuredClone(value);
}

export class CanvasProjectRepository {
  readonly projectRoot: string;
  readonly projectPath: string;
  readonly snapshotsRoot: string;
  private current: JsonObject | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
    this.projectPath = join(this.projectRoot, "canvas", "project.json");
    this.snapshotsRoot = join(this.projectRoot, "canvas", "snapshots");
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.projectPath), { recursive: true });
    await mkdir(this.snapshotsRoot, { recursive: true });
    try {
      this.current = validateProject(JSON.parse(await readFile(this.projectPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  read(): JsonObject | null {
    return this.current ? structuredClone(this.current) : null;
  }

  async save(
    value: unknown,
    forceSnapshot = false
  ): Promise<{ project: JsonObject; snapshotRelativePath: string | null }> {
    return this.exclusive(async () => {
      const project = validateProject(value);
      const revision = project.revision as number;
      const currentRevision = (this.current?.revision as number | undefined) ?? -1;
      if (revision < currentRevision) {
        throw new ProtocolError("INVALID_TRANSITION", `旧修订 ${revision} 不能覆盖当前修订 ${currentRevision}`);
      }
      const payload = `${JSON.stringify(project, null, 2)}\n`;
      const temporary = `${this.projectPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, payload, { encoding: "utf8", flag: "wx" });
      await rename(temporary, this.projectPath);
      this.current = project;

      let snapshotRelativePath: string | null = null;
      if (revision > currentRevision && (forceSnapshot || (revision > 0 && revision % 20 === 0))) {
        const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
        const filename = `project_rev${String(revision).padStart(6, "0")}_${stamp}.json`;
        const snapshotPath = join(this.snapshotsRoot, filename);
        await writeFile(snapshotPath, payload, { encoding: "utf8", flag: "wx" });
        snapshotRelativePath = `canvas/snapshots/${filename}`;
      }
      return { project: structuredClone(project), snapshotRelativePath };
    });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

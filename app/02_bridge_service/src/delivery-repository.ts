import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { ProtocolError, type ExportRecord, type ImageMime } from "@gpt-canvas/shared";
import type { CanvasAssetRepository } from "./canvas-asset-repository.js";
import type { TaskStore } from "./task-store.js";

const EXTENSION_BY_MIME: Readonly<Record<ImageMime, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp"
};

export interface DeliveryTarget {
  schemaVersion: "2.0";
  targetDirectory: string;
  configuredAt: string;
  updatedAt: string;
}

export interface ExportSelectionInput {
  assetId: unknown;
  versionId: unknown;
  viewpointName: unknown;
}

export interface BatchExportResult {
  targetDirectory: string;
  records: ExportRecord[];
  exported: number;
  deduplicated: number;
  failed: number;
  completed: boolean;
  logRelativePath: string;
}

interface StoredExportRecord extends ExportRecord {
  sourceRelativePath: string;
  targetDirectory: string;
}

interface LegacyDeliveryTarget {
  schemaVersion: "1.0";
  aiDirectory: string;
  configuredAt: string;
  updatedAt: string;
}

function cleanDirectory(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProtocolError("INVALID_INPUT", "请填写最终玻璃成果的导出文件夹绝对路径");
  }
  if (!isAbsolute(value.trim())) {
    throw new ProtocolError("INVALID_INPUT", "导出文件夹必须使用绝对路径");
  }
  const directory = resolve(value.trim());
  if (dirname(directory) === directory) {
    throw new ProtocolError("INVALID_INPUT", "不能把磁盘根目录作为批量导出文件夹");
  }
  return directory;
}

function cleanViewpointName(value: unknown): string {
  if (typeof value !== "string") throw new ProtocolError("INVALID_INPUT", "视角名称无效");
  const trimmed = value.trim();
  const extension = extname(trimmed);
  const withoutExtension = extension ? trimmed.slice(0, -extension.length) : trimmed;
  const clean = withoutExtension
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  if (!clean) throw new ProtocolError("INVALID_INPUT", "视角名称不能为空");
  return clean;
}

function requiredId(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ProtocolError("INVALID_INPUT", `${label}无效`);
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class DeliveryRepository {
  readonly configPath: string;
  readonly logPath: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly projectRoot: string,
    private readonly canvasAssets: CanvasAssetRepository,
    // Kept in the constructor for runtime compatibility; V3 export does not create PS prompt files.
    private readonly _store: TaskStore
  ) {
    this.configPath = join(resolve(projectRoot), "context", "delivery-target.json");
    this.logPath = join(resolve(projectRoot), "logs", "final-glass-export.ndjson");
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    await mkdir(dirname(this.logPath), { recursive: true });
  }

  async readTarget(): Promise<DeliveryTarget | null> {
    try {
      const parsed = JSON.parse(await readFile(this.configPath, "utf8")) as Partial<DeliveryTarget> | Partial<LegacyDeliveryTarget>;
      if (parsed.schemaVersion === "1.0" && typeof parsed.aiDirectory === "string") {
        return {
          schemaVersion: "2.0",
          targetDirectory: cleanDirectory(parsed.aiDirectory),
          configuredAt: typeof parsed.configuredAt === "string" ? parsed.configuredAt : new Date().toISOString(),
          updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString()
        };
      }
      if (
        parsed.schemaVersion !== "2.0"
        || typeof parsed.targetDirectory !== "string"
        || typeof parsed.configuredAt !== "string"
        || typeof parsed.updatedAt !== "string"
      ) {
        throw new ProtocolError("RECOVERY_REQUIRED", "批量导出目录配置损坏，请重新设置");
      }
      return { ...parsed, targetDirectory: cleanDirectory(parsed.targetDirectory) } as DeliveryTarget;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError("RECOVERY_REQUIRED", "批量导出目录配置无法读取，请重新设置");
    }
  }

  async saveTarget(targetDirectoryValue: unknown): Promise<DeliveryTarget> {
    const targetDirectory = cleanDirectory(targetDirectoryValue);
    const parentInfo = await stat(dirname(targetDirectory)).catch(() => null);
    if (!parentInfo?.isDirectory()) {
      throw new ProtocolError("INVALID_INPUT", "导出文件夹的上级目录不存在，请核对路径");
    }
    await mkdir(targetDirectory, { recursive: true });
    const targetInfo = await stat(targetDirectory).catch(() => null);
    if (!targetInfo?.isDirectory()) {
      throw new ProtocolError("INVALID_INPUT", "指定的导出路径不是文件夹");
    }

    const previous = await this.readTarget();
    const now = new Date().toISOString();
    const target: DeliveryTarget = {
      schemaVersion: "2.0",
      targetDirectory,
      configuredAt: previous?.configuredAt ?? now,
      updatedAt: now
    };
    if (previous) {
      const backupRoot = join(resolve(this.projectRoot), "backups", "delivery-target");
      await mkdir(backupRoot, { recursive: true });
      const backupPath = join(backupRoot, `delivery-target_before_${now.replaceAll(/[:.]/g, "-")}.json`);
      await writeFile(backupPath, `${JSON.stringify(previous, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    }
    const temporary = `${this.configPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(target, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, this.configPath);
    return target;
  }

  async exportSelected(values: readonly ExportSelectionInput[]): Promise<BatchExportResult> {
    if (!Array.isArray(values) || values.length === 0) {
      throw new ProtocolError("INVALID_INPUT", "请至少选择一张已验收的玻璃深化图");
    }
    return this.exclusive(async () => {
      const target = await this.readTarget();
      if (!target) throw new ProtocolError("TASK_LOCKED", "请先设置最终玻璃成果导出文件夹");
      const targetInfo = await stat(target.targetDirectory).catch(() => null);
      if (!targetInfo?.isDirectory()) {
        throw new ProtocolError("RECOVERY_REQUIRED", "已设置的导出文件夹不存在，请重新设置");
      }

      const storedRecords = await this.readRecords();
      const records: ExportRecord[] = [];
      for (const input of values) {
        try {
          const assetId = requiredId(input.assetId, /^asset_[A-Za-z0-9_-]+$/, "画布资产标识");
          const versionId = requiredId(input.versionId, /^version_[A-Za-z0-9_-]+$/, "画布版本标识") as `version_${string}`;
          const viewpointName = cleanViewpointName(input.viewpointName);
          const { asset, bytes } = await this.canvasAssets.readOriginal(assetId);
          if (asset.kind !== "generated") {
            throw new ProtocolError("INVALID_INPUT", "只有已回收到画布的生成成果可以导出");
          }
          const previous = storedRecords.findLast((record) => (
            record.assetId === asset.id
            && record.versionId === versionId
            && record.sha256 === asset.original.sha256
            && record.targetDirectory === target.targetDirectory
            && record.status !== "failed"
          ));
          if (previous) {
            const previousBytes = await readFile(previous.destinationPath).catch(() => null);
            if (
              previousBytes
              && previousBytes.byteLength === bytes.byteLength
              && createHash("sha256").update(previousBytes).digest("hex") === asset.original.sha256
            ) {
              const deduplicated: ExportRecord = { ...previous, status: "deduplicated", exportedAt: new Date().toISOString() };
              records.push(deduplicated);
              await this.appendRecord({ ...previous, status: "deduplicated", exportedAt: deduplicated.exportedAt });
              continue;
            }
          }
          const destination = await this.writeNextImage(
            target.targetDirectory,
            `${viewpointName}_玻璃整图`,
            EXTENSION_BY_MIME[asset.original.mime],
            bytes
          );
          const record: StoredExportRecord = {
            versionId,
            assetId: asset.id,
            viewpointName,
            destinationPath: destination,
            filename: basename(destination),
            sha256: asset.original.sha256,
            status: "exported",
            exportedAt: new Date().toISOString(),
            sourceRelativePath: asset.original.relativePath,
            targetDirectory: target.targetDirectory
          };
          await this.appendRecord(record);
          records.push(record);
          storedRecords.push(record);
        } catch (error) {
          records.push({
            versionId: typeof input.versionId === "string" && input.versionId.startsWith("version_")
              ? input.versionId as `version_${string}`
              : "version_invalid",
            assetId: typeof input.assetId === "string" && input.assetId.startsWith("asset_")
              ? input.assetId as `asset_${string}`
              : "asset_invalid",
            viewpointName: typeof input.viewpointName === "string" ? input.viewpointName : "未命名视角",
            destinationPath: "",
            filename: "",
            sha256: "",
            status: "failed",
            exportedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : "导出失败"
          });
        }
      }
      const exported = records.filter((record) => record.status === "exported").length;
      const deduplicated = records.filter((record) => record.status === "deduplicated").length;
      const failed = records.filter((record) => record.status === "failed").length;
      return {
        targetDirectory: target.targetDirectory,
        records,
        exported,
        deduplicated,
        failed,
        completed: failed === 0,
        logRelativePath: "logs/final-glass-export.ndjson"
      };
    });
  }

  private async appendRecord(record: StoredExportRecord): Promise<void> {
    await writeFile(this.logPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
  }

  private async writeNextImage(directory: string, prefix: string, extension: string, bytes: Buffer): Promise<string> {
    const entries = await readdir(directory);
    const pattern = new RegExp(`^${escapeRegExp(prefix)}_(\\d{2,})\\.(?:png|jpe?g|webp)$`, "i");
    let next = entries.reduce((highest, entry) => {
      const match = entry.match(pattern);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0) + 1;
    while (next < 10_000) {
      const destination = join(directory, `${prefix}_${String(next).padStart(2, "0")}${extension}`);
      try {
        await writeFile(destination, bytes, { flag: "wx" });
        return destination;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        next += 1;
      }
    }
    throw new ProtocolError("RECOVERY_REQUIRED", `视角“${prefix}”的导出版本号已超过安全范围`);
  }

  private async readRecords(): Promise<StoredExportRecord[]> {
    try {
      return (await readFile(this.logPath, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try { return [JSON.parse(line) as StoredExportRecord]; }
          catch { return []; }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private exclusive<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(mutation, mutation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

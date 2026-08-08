import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { ProtocolError, type ImageMime } from "@gpt-canvas/shared";
import type { CanvasAssetRepository } from "./canvas-asset-repository.js";
import type { TaskStore } from "./task-store.js";

const EXTENSION_BY_MIME: Readonly<Record<ImageMime, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp"
};

export type DeliveryStage = "stage-3" | "stage-4" | "final";

export interface DeliveryTarget {
  schemaVersion: "1.0";
  aiDirectory: string;
  finalDirectory: string;
  configuredAt: string;
  updatedAt: string;
}

export interface AdoptCanvasAssetInput {
  viewpointName: unknown;
  stage: unknown;
  taskId?: unknown;
  versionId?: unknown;
}

export interface AdoptionRecord {
  schemaVersion: "1.0";
  at: string;
  assetId: string;
  versionId: string | null;
  taskId: string | null;
  viewpointName: string;
  stage: DeliveryStage;
  usage: "ai-version" | "ps-glass-full-frame";
  sourceRelativePath: string;
  sourceSha256: string;
  destinationPath: string;
  filename: string;
  promptDestinationPath: string | null;
  targetAiDirectory: string;
  logRelativePath: string;
  deduplicated: boolean;
}

interface StoredAdoptionRecord extends Omit<AdoptionRecord, "deduplicated"> {}

function cleanDirectory(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProtocolError("INVALID_INPUT", "请填写正式效果图项目中的 AI 目录绝对路径");
  }
  const directory = resolve(value.trim());
  if (!isAbsolute(value.trim()) || basename(directory).toLocaleLowerCase() !== "ai") {
    throw new ProtocolError("INVALID_INPUT", "正式交接目录必须是绝对路径，并以 AI 目录结尾");
  }
  if (dirname(directory) === directory) {
    throw new ProtocolError("INVALID_INPUT", "正式交接目录不能是磁盘根目录");
  }
  return directory;
}

function cleanViewpointName(value: unknown): string {
  if (typeof value !== "string") throw new ProtocolError("INVALID_INPUT", "视角名称无效");
  const withoutExtension = value.trim().replace(new RegExp(`${extname(value.trim()).replace(".", "\\.")}$`, "i"), "");
  const clean = withoutExtension
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  if (!clean) throw new ProtocolError("INVALID_INPUT", "视角名称不能为空");
  return clean;
}

function deliveryStage(value: unknown): DeliveryStage {
  if (value === "stage-3" || value === "stage-4" || value === "final") return value;
  throw new ProtocolError("INVALID_INPUT", "只有风格深化、整图玻璃深化或最终检查阶段的生成成果可以正式归档");
}

function optionalId(value: unknown, pattern: RegExp, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ProtocolError("INVALID_INPUT", `${label}无效`);
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function promptPrefix(viewpointName: string, stage: DeliveryStage): string {
  return stage === "stage-4" ? `${viewpointName}_玻璃整图` : viewpointName;
}

export class DeliveryRepository {
  readonly configPath: string;
  readonly logPath: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly projectRoot: string,
    private readonly canvasAssets: CanvasAssetRepository,
    private readonly store: TaskStore
  ) {
    this.configPath = join(resolve(projectRoot), "context", "delivery-target.json");
    this.logPath = join(resolve(projectRoot), "logs", "formal-adoption.ndjson");
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    await mkdir(dirname(this.logPath), { recursive: true });
  }

  async readTarget(): Promise<DeliveryTarget | null> {
    try {
      const parsed = JSON.parse(await readFile(this.configPath, "utf8")) as Partial<DeliveryTarget>;
      if (
        parsed.schemaVersion !== "1.0"
        || typeof parsed.aiDirectory !== "string"
        || typeof parsed.finalDirectory !== "string"
        || typeof parsed.configuredAt !== "string"
        || typeof parsed.updatedAt !== "string"
      ) {
        throw new ProtocolError("RECOVERY_REQUIRED", "正式交接目录配置损坏，请重新设置");
      }
      const aiDirectory = cleanDirectory(parsed.aiDirectory);
      if (resolve(parsed.finalDirectory) !== join(dirname(aiDirectory), "成图")) {
        throw new ProtocolError("RECOVERY_REQUIRED", "正式交接目录配置与成图目录不匹配，请重新设置");
      }
      return { ...parsed, aiDirectory } as DeliveryTarget;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof ProtocolError) throw error;
      throw new ProtocolError("RECOVERY_REQUIRED", "正式交接目录配置无法读取，请重新设置");
    }
  }

  async saveTarget(aiDirectoryValue: unknown): Promise<DeliveryTarget> {
    const aiDirectory = cleanDirectory(aiDirectoryValue);
    const parent = dirname(aiDirectory);
    const parentInfo = await stat(parent).catch(() => null);
    if (!parentInfo?.isDirectory()) {
      throw new ProtocolError("INVALID_INPUT", "AI 目录的上级效果图目录不存在，请核对正式项目路径");
    }
    const finalDirectory = join(parent, "成图");
    await mkdir(aiDirectory, { recursive: true });
    await mkdir(finalDirectory, { recursive: true });

    const previous = await this.readTarget();
    const now = new Date().toISOString();
    const target: DeliveryTarget = {
      schemaVersion: "1.0",
      aiDirectory,
      finalDirectory,
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

  async adopt(assetId: string, input: AdoptCanvasAssetInput): Promise<AdoptionRecord> {
    return this.exclusive(async () => {
      const target = await this.readTarget();
      if (!target) throw new ProtocolError("TASK_LOCKED", "请先设置正式效果图项目的 AI 目录");
      const targetInfo = await stat(target.aiDirectory).catch(() => null);
      if (!targetInfo?.isDirectory()) {
        throw new ProtocolError("RECOVERY_REQUIRED", "已设置的正式 AI 目录不存在，请重新设置");
      }
      const stage = deliveryStage(input.stage);
      const viewpointName = cleanViewpointName(input.viewpointName);
      const taskId = optionalId(input.taskId, /^task_[A-Za-z0-9_-]+$/, "生成任务标识");
      const versionId = optionalId(input.versionId, /^version_[A-Za-z0-9_-]+$/, "画布版本标识");
      const { asset, bytes } = await this.canvasAssets.readOriginal(assetId);
      if (asset.kind !== "generated") {
        throw new ProtocolError("INVALID_INPUT", "只有已回收到画布的生成成果可以正式归档");
      }

      const storedRecords = await this.readRecords();
      const previous = storedRecords.findLast((record) => (
        record.assetId === asset.id
        && record.sourceSha256 === asset.original.sha256
        && record.viewpointName === viewpointName
        && record.stage === stage
        && record.targetAiDirectory === target.aiDirectory
      ));
      if (previous) {
        const previousBytes = await readFile(previous.destinationPath).catch(() => null);
        if (
          previousBytes
          && previousBytes.byteLength === bytes.byteLength
          && createHash("sha256").update(previousBytes).digest("hex") === asset.original.sha256
        ) {
          return { ...previous, deduplicated: true };
        }
      }

      const prefix = promptPrefix(viewpointName, stage);
      const destination = await this.writeNextImage(target.aiDirectory, prefix, EXTENSION_BY_MIME[asset.original.mime], bytes);
      const promptDestinationPath = taskId
        ? await this.writePromptIfAvailable(target.aiDirectory, prefix, taskId)
        : null;
      const record: StoredAdoptionRecord = {
        schemaVersion: "1.0",
        at: new Date().toISOString(),
        assetId: asset.id,
        versionId,
        taskId,
        viewpointName,
        stage,
        usage: stage === "stage-4" ? "ps-glass-full-frame" : "ai-version",
        sourceRelativePath: asset.original.relativePath,
        sourceSha256: asset.original.sha256,
        destinationPath: destination,
        filename: basename(destination),
        promptDestinationPath,
        targetAiDirectory: target.aiDirectory,
        logRelativePath: "logs/formal-adoption.ndjson"
      };
      await writeFile(this.logPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
      return { ...record, deduplicated: false };
    });
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
    throw new ProtocolError("RECOVERY_REQUIRED", `视角“${prefix}”的 AI 版本号已超过安全范围`);
  }

  private async writePromptIfAvailable(directory: string, prefix: string, taskId: string): Promise<string | null> {
    const task = this.store.get(taskId);
    if (!task) throw new ProtocolError("TASK_NOT_FOUND", `生成任务不存在：${taskId}`);
    const content = `${task.prompt.trim()}\n`;
    const base = join(directory, `${prefix}_提示词.txt`);
    try {
      await writeFile(base, content, { encoding: "utf8", flag: "wx" });
      return base;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (await readFile(base, "utf8").catch(() => null) === content) return base;
    for (let version = 2; version < 10_000; version += 1) {
      const destination = join(directory, `${prefix}_提示词_v${String(version).padStart(2, "0")}.txt`);
      try {
        await writeFile(destination, content, { encoding: "utf8", flag: "wx" });
        return destination;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await readFile(destination, "utf8").catch(() => null) === content) return destination;
      }
    }
    throw new ProtocolError("RECOVERY_REQUIRED", `视角“${prefix}”的提示词版本号已超过安全范围`);
  }

  private async readRecords(): Promise<StoredAdoptionRecord[]> {
    try {
      return (await readFile(this.logPath, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try { return [JSON.parse(line) as StoredAdoptionRecord]; }
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

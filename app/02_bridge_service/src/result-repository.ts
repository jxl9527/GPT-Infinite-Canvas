import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { ProtocolError, type GenerationResult, type ImageMime } from "@gpt-canvas/shared";
import type { TaskStore } from "./task-store.js";

const MAX_RESULT_BYTES = 40 * 1024 * 1024;
const EXTENSION_BY_MIME: Readonly<Record<ImageMime, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp"
};

function decodeDataUrl(value: unknown): { mime: ImageMime; bytes: Buffer } {
  if (typeof value !== "string") throw new ProtocolError("INVALID_INPUT", "结果 dataUrl 缺失");
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match || !match[1] || !match[2] || match[2].length % 4 !== 0) {
    throw new ProtocolError("INVALID_INPUT", "结果必须是 PNG、JPEG 或 WebP 的有效 base64 data URL");
  }
  const mime = match[1] as ImageMime; const bytes = Buffer.from(match[2], "base64");
  if (!bytes.byteLength || bytes.byteLength > MAX_RESULT_BYTES) {
    throw new ProtocolError("INVALID_INPUT", "结果图片必须是 40 MiB 以内的非空文件");
  }
  const validMagic = mime === "image/png"
    ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    : mime === "image/jpeg"
      ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!validMagic) throw new ProtocolError("INVALID_INPUT", "结果图片内容与声明格式不一致");
  return { mime, bytes };
}

export class ResultRepository {
  private readonly taskLocks = new Map<string, Promise<void>>();

  constructor(readonly projectRoot: string, readonly store: TaskStore) {}

  async saveDataUrl(
    taskId: string,
    dataUrl: unknown,
    source: GenerationResult["source"] = "visible-page"
  ): Promise<{ result: GenerationResult; deduplicated: boolean }> {
    return this.exclusive(taskId, async () => {
      const task = this.store.get(taskId);
      if (!task) throw new ProtocolError("TASK_NOT_FOUND", `任务不存在：${taskId}`);
      if (task.status !== "collecting") throw new ProtocolError("RESULT_STATE_REJECTED", "只有 collecting 状态可以写入结果");
      const decoded = decodeDataUrl(dataUrl); const sha256 = createHash("sha256").update(decoded.bytes).digest("hex");
      if (task.attachments.some((attachment) => attachment.sha256 === sha256)) {
        throw new ProtocolError("RESULT_MATCHES_ATTACHMENT", "检测到结果与输入附件完全相同，已拒绝把原图回收到画布");
      }
      const existing = task.results.find((candidate) => candidate.sha256 === sha256);
      if (existing) return { result: existing, deduplicated: true };

      const resultRoot = join(this.projectRoot, "runs", taskId, "results"); await mkdir(resultRoot, { recursive: true });
      const filename = `result_${Date.now()}_${randomUUID().slice(0, 8)}${EXTENSION_BY_MIME[decoded.mime]}`;
      const destination = join(resultRoot, filename); const temporary = `${destination}.${randomUUID()}.tmp`;
      await writeFile(temporary, decoded.bytes, { flag: "wx" }); await rename(temporary, destination);
      const result: GenerationResult = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        filename,
        mime: decoded.mime,
        bytes: decoded.bytes.byteLength,
        sha256,
        relativePath: `runs/${taskId}/results/${filename}`,
        source
      };
      try {
        const stored = await this.store.addResult(taskId, result);
        if (stored.deduplicated) await this.quarantine(taskId, destination, filename, "duplicate");
        await this.writeIndex(taskId);
        return stored;
      } catch (error) {
        await this.quarantine(taskId, destination, filename, "rejected");
        throw error;
      }
    });
  }

  async read(taskId: string, resultId: string): Promise<{ result: GenerationResult; bytes: Buffer }> {
    const task = this.store.get(taskId);
    if (!task) throw new ProtocolError("TASK_NOT_FOUND", `任务不存在：${taskId}`);
    const result = task.results.find((candidate) => candidate.id === resultId);
    if (!result) throw new ProtocolError("TASK_NOT_FOUND", `任务结果不存在：${resultId}`);
    const absolute = resolve(this.projectRoot, result.relativePath);
    const resultRoot = resolve(this.projectRoot, "runs", taskId, "results");
    if (!(absolute === resultRoot || absolute.startsWith(`${resultRoot}${sep}`))) {
      throw new ProtocolError("RECOVERY_REQUIRED", "任务结果路径越界");
    }
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile() || info.size !== result.bytes) {
      throw new ProtocolError("RECOVERY_REQUIRED", "任务结果文件缺失或大小不匹配");
    }
    const bytes = await readFile(absolute);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== result.sha256) {
      throw new ProtocolError("RECOVERY_REQUIRED", "任务结果哈希不匹配");
    }
    return { result: structuredClone(result), bytes };
  }

  private async writeIndex(taskId: string): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) throw new ProtocolError("TASK_NOT_FOUND", `任务不存在：${taskId}`);
    const runRoot = join(this.projectRoot, "runs", taskId); await mkdir(runRoot, { recursive: true });
    const destination = join(runRoot, "result-index.json"); const temporary = `${destination}.${randomUUID()}.tmp`;
    const payload = { schemaVersion: task.schemaVersion, taskId, updatedAt: new Date().toISOString(), results: task.results };
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination);
  }

  private async quarantine(taskId: string, sourcePath: string, filename: string, reason: string): Promise<void> {
    const root = join(this.projectRoot, "runs", taskId, "orphaned"); await mkdir(root, { recursive: true });
    await rename(sourcePath, join(root, `${reason}_${randomUUID().slice(0, 8)}_${filename}`));
  }

  private async exclusive<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskLocks.get(taskId) ?? Promise.resolve();
    let release!: () => void; const current = new Promise<void>((resolveLock) => { release = resolveLock; });
    this.taskLocks.set(taskId, current); await previous;
    try { return await operation(); }
    finally { release(); if (this.taskLocks.get(taskId) === current) this.taskLocks.delete(taskId); }
  }
}

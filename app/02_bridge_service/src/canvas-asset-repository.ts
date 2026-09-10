import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  ProtocolError,
  type CanvasAssetKind,
  type CanvasImageAsset,
  type ImageMime
} from "@gpt-canvas/shared";

const MAX_IMPORT_BYTES = 40 * 1024 * 1024;
const EXTENSION_BY_MIME: Readonly<Record<ImageMime, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp"
};

interface AssetIndex {
  schemaVersion: "1.0";
  updatedAt: string;
  assets: CanvasImageAsset[];
}

function decodeDataUrl(value: unknown): { mime: ImageMime; bytes: Buffer } {
  if (typeof value !== "string") throw new ProtocolError("INVALID_ATTACHMENT", "导入图片 dataUrl 缺失");
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match?.[1] || !match[2] || match[2].length % 4 !== 0) {
    throw new ProtocolError("INVALID_ATTACHMENT", "只允许有效的 PNG、JPEG 或 WebP base64 图片");
  }
  const mime = match[1] as ImageMime;
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.byteLength || bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new ProtocolError("INVALID_ATTACHMENT", "导入图片必须是 40 MiB 以内的非空文件");
  }
  return { mime, bytes };
}

function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.byteLength < 24 || !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 8 < bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset]; offset += 1;
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.byteLength) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.byteLength) break;
    if (startOfFrame.has(marker) && length >= 7) {
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function webpSize(bytes: Buffer): { width: number; height: number } | null {
  if (
    bytes.byteLength < 30
    || bytes.subarray(0, 4).toString("ascii") !== "RIFF"
    || bytes.subarray(8, 12).toString("ascii") !== "WEBP"
  ) return null;
  const chunk = bytes.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X") {
    return { width: readUInt24LE(bytes, 24) + 1, height: readUInt24LE(bytes, 27) + 1 };
  }
  if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    const packed = bytes.readUInt32LE(21);
    return { width: (packed & 0x3fff) + 1, height: ((packed >> 14) & 0x3fff) + 1 };
  }
  return null;
}

function imageSize(mime: ImageMime, bytes: Buffer): { width: number; height: number } {
  const size = mime === "image/png" ? pngSize(bytes) : mime === "image/jpeg" ? jpegSize(bytes) : webpSize(bytes);
  if (!size || size.width < 1 || size.height < 1 || size.width > 100_000 || size.height > 100_000) {
    throw new ProtocolError("INVALID_ATTACHMENT", "图片内容与声明格式不一致，或尺寸无法识别");
  }
  return size;
}

function cleanOriginalName(value: unknown, mime: ImageMime): string {
  if (typeof value !== "string" || !value.trim()) return `未命名图片${EXTENSION_BY_MIME[mime]}`;
  const clean = basename(value.trim()).replaceAll(/[\u0000-\u001f<>:"/\\|?*]/g, "_").slice(0, 180);
  return clean || `未命名图片${EXTENSION_BY_MIME[mime]}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class CanvasAssetRepository {
  readonly projectRoot: string;
  readonly originalsRoot: string;
  readonly displayRoot: string;
  readonly thumbnailsRoot: string;
  readonly annotationsRoot: string;
  readonly indexPath: string;
  private readonly assets = new Map<string, CanvasImageAsset>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
    this.originalsRoot = join(this.projectRoot, "assets", "originals");
    this.displayRoot = join(this.projectRoot, "assets", "display");
    this.thumbnailsRoot = join(this.projectRoot, "assets", "thumbnails");
    this.annotationsRoot = join(this.projectRoot, "annotations");
    this.indexPath = join(this.projectRoot, "assets", "asset-index.json");
  }

  async init(): Promise<void> {
    await mkdir(this.originalsRoot, { recursive: true });
    await mkdir(this.displayRoot, { recursive: true });
    await mkdir(this.thumbnailsRoot, { recursive: true });
    await mkdir(this.annotationsRoot, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, "utf8")) as Partial<AssetIndex>;
      if (parsed.schemaVersion !== "1.0" || !Array.isArray(parsed.assets)) {
        throw new ProtocolError("RECOVERY_REQUIRED", "图片资产索引版本无效");
      }
      for (const asset of parsed.assets) this.assets.set(asset.id, asset);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  list(): CanvasImageAsset[] {
    return [...this.assets.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(clone);
  }

  get(id: string): CanvasImageAsset | undefined {
    const asset = this.assets.get(id);
    return asset ? clone(asset) : undefined;
  }

  async importDataUrl(name: unknown, dataUrl: unknown): Promise<{ asset: CanvasImageAsset; deduplicated: boolean }> {
    return this.saveDataUrl("imported", name, dataUrl);
  }

  async importVerifiedFile(
    name: string,
    sourcePath: string,
    mime: ImageMime
  ): Promise<{ asset: CanvasImageAsset; deduplicated: boolean }> {
    const bytes = await readFile(sourcePath);
    return this.saveDataUrl("imported", name, `data:${mime};base64,${bytes.toString("base64")}`);
  }

  async saveAnnotationExport(name: unknown, dataUrl: unknown): Promise<{ asset: CanvasImageAsset; deduplicated: boolean }> {
    return this.saveDataUrl("annotation-export", name, dataUrl);
  }

  async saveGeneratedAsset(name: unknown, dataUrl: unknown): Promise<{ asset: CanvasImageAsset; deduplicated: boolean }> {
    return this.saveDataUrl("generated", name, dataUrl);
  }

  async saveDerivatives(
    id: string,
    displayDataUrl: unknown,
    thumbnailDataUrl: unknown
  ): Promise<{ asset: CanvasImageAsset; deduplicated: boolean }> {
    return this.exclusive(async () => {
      const asset = this.assets.get(id);
      if (!asset) throw new ProtocolError("TASK_NOT_FOUND", `图片资产不存在：${id}`);
      const display = decodeDataUrl(displayDataUrl);
      const thumbnail = decodeDataUrl(thumbnailDataUrl);
      const displayRecord = await this.writeDerivative(asset, "display", display.mime, display.bytes);
      const thumbnailRecord = await this.writeDerivative(asset, "thumbnail", thumbnail.mime, thumbnail.bytes);
      const deduplicated = asset.display?.sha256 === displayRecord.sha256
        && asset.thumbnail?.sha256 === thumbnailRecord.sha256;
      const updated: CanvasImageAsset = {
        ...asset,
        display: displayRecord,
        thumbnail: thumbnailRecord
      };
      this.assets.set(id, updated);
      await this.persistIndex();
      return { asset: clone(updated), deduplicated };
    });
  }

  private async saveDataUrl(
    kind: CanvasAssetKind,
    name: unknown,
    dataUrl: unknown
  ): Promise<{ asset: CanvasImageAsset; deduplicated: boolean }> {
    return this.exclusive(async () => {
      const decoded = decodeDataUrl(dataUrl);
      const dimensions = imageSize(decoded.mime, decoded.bytes);
      const sha256 = createHash("sha256").update(decoded.bytes).digest("hex");
      const existing = [...this.assets.values()].find((candidate) =>
        candidate.kind === kind && candidate.original.sha256 === sha256
      );
      if (existing) return { asset: clone(existing), deduplicated: true };

      const id = `asset_${randomUUID()}` as const;
      const extension = EXTENSION_BY_MIME[decoded.mime];
      const filename = `${id}${extension}`;
      const storageRoot = kind === "annotation-export" ? this.annotationsRoot : this.originalsRoot;
      const relativeRoot = kind === "annotation-export" ? "annotations" : "assets/originals";
      const destination = join(storageRoot, filename);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await writeFile(temporary, decoded.bytes, { flag: "wx" });
      await rename(temporary, destination);
      const asset: CanvasImageAsset = {
        id,
        kind,
        originalName: cleanOriginalName(name, decoded.mime),
        original: {
          relativePath: `${relativeRoot}/${filename}`,
          mime: decoded.mime,
          width: dimensions.width,
          height: dimensions.height,
          bytes: decoded.bytes.byteLength,
          sha256
        },
        createdAt: new Date().toISOString()
      };
      this.assets.set(asset.id, asset);
      try {
        await this.persistIndex();
      } catch (error) {
        this.assets.delete(asset.id);
        const orphanRoot = join(this.projectRoot, "backups", "orphaned");
        await mkdir(orphanRoot, { recursive: true });
        await rename(destination, join(orphanRoot, `${filename}.${randomUUID()}.orphan`)).catch(() => undefined);
        throw error;
      }
      return { asset: clone(asset), deduplicated: false };
    });
  }

  async readOriginal(id: string): Promise<{ asset: CanvasImageAsset; bytes: Buffer }> {
    return this.readRendition(id, "original");
  }

  async readRendition(
    id: string,
    rendition: "original" | "display" | "thumbnail"
  ): Promise<{ asset: CanvasImageAsset; bytes: Buffer }> {
    const asset = this.assets.get(id);
    if (!asset) throw new ProtocolError("TASK_NOT_FOUND", `图片资产不存在：${id}`);
    const record = rendition === "original" ? asset.original : asset[rendition];
    if (!record) throw new ProtocolError("TASK_NOT_FOUND", `图片资产缺少 ${rendition} 图层`);
    const absolute = resolve(this.projectRoot, record.relativePath);
    const allowedRoot = rendition === "display"
      ? this.displayRoot
      : rendition === "thumbnail"
        ? this.thumbnailsRoot
        : asset.kind === "annotation-export"
          ? this.annotationsRoot
          : this.originalsRoot;
    if (!(absolute === allowedRoot || absolute.startsWith(`${allowedRoot}${sep}`))) {
      throw new ProtocolError("RECOVERY_REQUIRED", "图片资产路径越界");
    }
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile() || info.size !== record.bytes) {
      throw new ProtocolError("RECOVERY_REQUIRED", `图片资产文件缺失或大小不匹配：${asset.originalName}`);
    }
    const bytes = await readFile(absolute);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== record.sha256) {
      throw new ProtocolError("RECOVERY_REQUIRED", `图片资产哈希不匹配：${asset.originalName}`);
    }
    return { asset: clone(asset), bytes };
  }

  private async writeDerivative(
    asset: CanvasImageAsset,
    rendition: "display" | "thumbnail",
    mime: ImageMime,
    bytes: Buffer
  ): Promise<CanvasImageAsset["original"]> {
    const dimensions = imageSize(mime, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = asset[rendition];
    if (existing?.sha256 === sha256) return existing;
    const root = rendition === "display" ? this.displayRoot : this.thumbnailsRoot;
    const relativeRoot = rendition === "display" ? "assets/display" : "assets/thumbnails";
    const filename = `${asset.id}_${randomUUID().slice(0, 8)}${EXTENSION_BY_MIME[mime]}`;
    const destination = join(root, filename);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, destination);
    return {
      relativePath: `${relativeRoot}/${filename}`,
      mime,
      width: dimensions.width,
      height: dimensions.height,
      bytes: bytes.byteLength,
      sha256
    };
  }

  private async persistIndex(): Promise<void> {
    await mkdir(dirname(this.indexPath), { recursive: true });
    const payload: AssetIndex = {
      schemaVersion: "1.0",
      updatedAt: new Date().toISOString(),
      assets: this.list()
    };
    const temporary = `${this.indexPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, this.indexPath);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

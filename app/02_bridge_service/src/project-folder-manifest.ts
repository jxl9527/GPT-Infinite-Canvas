import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, parse, relative, resolve } from "node:path";
import {
  ProtocolError,
  type ImageMime,
  type ProjectFolderFileRole,
  type ProjectFolderImportResult,
  type ProjectFolderManifest,
  type ProjectFolderManifestFile
} from "@gpt-canvas/shared";
import type { CanvasAssetRepository } from "./canvas-asset-repository.js";

const MAX_MANIFEST_FILES = 500;
const MAX_SCANNED_DIRECTORIES = 1_000;
const MAX_IMPORT_BYTES = 40 * 1024 * 1024;
const MANIFEST_ID_PATTERN = /^manifest_[0-9a-f-]{36}$/;
const MIME_BY_EXTENSION = new Map<string, ImageMime>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"]
]);
const naturalCollator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

function pathInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

function cleanRelativePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function roleAndViewpoint(name: string): {
  suggestedRole: ProjectFolderFileRole;
  viewpointKey: string;
  importable: boolean;
  reason?: string;
} {
  const base = basename(name, extname(name));
  const normalized = base.toLocaleLowerCase("zh-CN");
  const channelPattern = /(?:^|[_\-\s])(ao|material\s*id|materialid|transparent|sky\s*mask|skymask|z\s*-?\s*depth|zdepth|reflection|normal|albedo)(?:$|[_\-\s])/i;
  const stylePattern = /风格|参考|reference|style/i;
  const suPattern = /(?:^|[_\-\s])su(?:$|[_\-\s])|sketchup|白模|模型/i;

  let suggestedRole: ProjectFolderFileRole = "d5-view";
  let importable = true;
  let reason: string | undefined;
  if (channelPattern.test(normalized)) {
    suggestedRole = "ignored-channel";
    importable = false;
    reason = "识别为 D5 后期通道图，默认不进入 AI 画布";
  } else if (stylePattern.test(normalized)) {
    suggestedRole = "style-reference";
  } else if (suPattern.test(normalized)) {
    suggestedRole = "su-reference";
  }

  const viewpointKey = base
    .replace(channelPattern, " ")
    .replace(/(?:^|[_\-\s])(su|sketchup)(?:$|[_\-\s])/ig, " ")
    .replace(/风格|参考|reference|style/ig, " ")
    .replace(/[_\-\s]+/g, " ")
    .trim() || base;
  return { suggestedRole, viewpointKey, importable, ...(reason ? { reason } : {}) };
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function manifestId(value: unknown): `manifest_${string}` {
  if (typeof value !== "string" || !MANIFEST_ID_PATTERN.test(value)) {
    throw new ProtocolError("INVALID_INPUT", "项目文件夹清单标识无效");
  }
  return value as `manifest_${string}`;
}

function assertManifest(value: unknown): asserts value is ProjectFolderManifest {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (value as ProjectFolderManifest).schemaVersion !== "1.0"
    || !MANIFEST_ID_PATTERN.test((value as ProjectFolderManifest).id)
    || typeof (value as ProjectFolderManifest).sourceRoot !== "string"
    || !Array.isArray((value as ProjectFolderManifest).files)
  ) {
    throw new ProtocolError("RECOVERY_REQUIRED", "项目文件夹清单损坏或版本不兼容");
  }
}

export class ProjectFolderManifestService {
  readonly projectRoot: string;
  readonly manifestsRoot: string;
  readonly logPath: string;

  constructor(projectRoot: string, private readonly assets: CanvasAssetRepository) {
    this.projectRoot = resolve(projectRoot);
    this.manifestsRoot = join(this.projectRoot, "workflow", "manifests");
    this.logPath = join(this.projectRoot, "logs", "folder-import.ndjson");
  }

  async init(): Promise<void> {
    await mkdir(this.manifestsRoot, { recursive: true });
    await mkdir(join(this.projectRoot, "logs"), { recursive: true });
  }

  async scan(sourceRootValue: unknown, includeSubfoldersValue: unknown = false): Promise<ProjectFolderManifest> {
    if (typeof sourceRootValue !== "string" || !sourceRootValue.trim() || !isAbsolute(sourceRootValue.trim())) {
      throw new ProtocolError("INVALID_INPUT", "项目文件夹必须是明确的绝对路径");
    }
    const includeSubfolders = includeSubfoldersValue === true;
    const requestedRoot = resolve(sourceRootValue.trim());
    const rootInfo = await stat(requestedRoot).catch(() => null);
    if (!rootInfo?.isDirectory()) throw new ProtocolError("INVALID_INPUT", "指定的项目文件夹不存在或不是目录");
    const sourceRoot = await realpath(requestedRoot);
    if (sourceRoot.toLocaleLowerCase("en-US") === parse(sourceRoot).root.toLocaleLowerCase("en-US")) {
      throw new ProtocolError("INVALID_INPUT", "不允许扫描磁盘根目录");
    }

    const files: ProjectFolderManifestFile[] = [];
    const directories = [sourceRoot];
    let scannedDirectories = 0;
    while (directories.length) {
      const directory = directories.shift();
      if (!directory) break;
      scannedDirectories += 1;
      if (scannedDirectories > MAX_SCANNED_DIRECTORIES) {
        throw new ProtocolError("INVALID_INPUT", `项目文件夹子目录超过 ${MAX_SCANNED_DIRECTORIES} 个，已停止扫描`);
      }
      const entries = (await readdir(directory, { withFileTypes: true }))
        .sort((left, right) => naturalCollator.compare(left.name, right.name));
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name.startsWith("~$")) continue;
        const candidate = resolve(directory, entry.name);
        if (!pathInside(sourceRoot, candidate)) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (includeSubfolders) directories.push(candidate);
          continue;
        }
        if (!entry.isFile()) continue;
        const mime = MIME_BY_EXTENSION.get(extname(entry.name).toLocaleLowerCase("en-US"));
        if (!mime) continue;
        if (files.length >= MAX_MANIFEST_FILES) {
          throw new ProtocolError("INVALID_INPUT", `可识别图片超过 ${MAX_MANIFEST_FILES} 张，请缩小扫描范围`);
        }
        const canonical = await realpath(candidate);
        if (!pathInside(sourceRoot, canonical)) continue;
        const info = await stat(canonical);
        const suggestion = roleAndViewpoint(entry.name);
        const tooLarge = info.size > MAX_IMPORT_BYTES;
        files.push({
          relativePath: cleanRelativePath(relative(sourceRoot, canonical)),
          name: entry.name,
          mime,
          bytes: info.size,
          sha256: tooLarge ? "" : await fileSha256(canonical),
          modifiedAt: info.mtime.toISOString(),
          suggestedRole: suggestion.suggestedRole,
          viewpointKey: suggestion.viewpointKey,
          importable: suggestion.importable && !tooLarge,
          ...(
            tooLarge
              ? { reason: "图片超过 40 MiB 导入上限" }
              : suggestion.reason
                ? { reason: suggestion.reason }
                : {}
          )
        });
      }
    }

    files.sort((left, right) => naturalCollator.compare(left.relativePath, right.relativePath));
    const manifest: ProjectFolderManifest = {
      schemaVersion: "1.0",
      id: `manifest_${randomUUID()}`,
      sourceRoot,
      includeSubfolders,
      scannedAt: new Date().toISOString(),
      fileCount: files.length,
      importableCount: files.filter((file) => file.importable).length,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      files
    };
    await this.persist(manifest);
    await this.log({
      at: manifest.scannedAt,
      action: "scan",
      manifestId: manifest.id,
      sourceRoot: manifest.sourceRoot,
      fileCount: manifest.fileCount,
      importableCount: manifest.importableCount
    });
    return structuredClone(manifest);
  }

  async read(idValue: unknown): Promise<ProjectFolderManifest> {
    const id = manifestId(idValue);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(this.manifestsRoot, `${id}.json`), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ProtocolError("TASK_NOT_FOUND", "项目文件夹清单不存在");
      }
      throw error;
    }
    assertManifest(parsed);
    return structuredClone(parsed);
  }

  async importManifest(idValue: unknown, selectedRelativePathsValue?: unknown): Promise<ProjectFolderImportResult> {
    const manifest = await this.read(idValue);
    let selected: Set<string> | null = null;
    if (selectedRelativePathsValue !== undefined) {
      if (!Array.isArray(selectedRelativePathsValue) || selectedRelativePathsValue.some((item) => typeof item !== "string")) {
        throw new ProtocolError("INVALID_INPUT", "selectedRelativePaths 必须是字符串数组");
      }
      selected = new Set(selectedRelativePathsValue as string[]);
      const known = new Set(manifest.files.map((file) => file.relativePath));
      for (const relativePath of selected) {
        if (!known.has(relativePath)) throw new ProtocolError("INVALID_INPUT", `清单中不存在文件：${relativePath}`);
      }
    }
    const candidates = manifest.files.filter((file) => file.importable && (!selected || selected.has(file.relativePath)));
    if (!candidates.length) throw new ProtocolError("INVALID_INPUT", "清单中没有可导入图片");

    const items: ProjectFolderImportResult["items"] = [];
    for (const file of candidates) {
      try {
        const candidate = resolve(manifest.sourceRoot, file.relativePath);
        if (!pathInside(manifest.sourceRoot, candidate)) throw new ProtocolError("INVALID_INPUT", "源图片路径越界");
        const linkInfo = await lstat(candidate);
        if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
          throw new ProtocolError("INVALID_INPUT", "源图片已变为链接或非普通文件");
        }
        const canonical = await realpath(candidate);
        if (!pathInside(manifest.sourceRoot, canonical)) throw new ProtocolError("INVALID_INPUT", "源图片真实路径越界");
        const info = await stat(canonical);
        if (info.size !== file.bytes || await fileSha256(canonical) !== file.sha256) {
          throw new ProtocolError("RECOVERY_REQUIRED", "源图片在清单确认后已发生变化，请重新扫描");
        }
        const imported = await this.assets.importVerifiedFile(file.name, canonical, file.mime);
        items.push({
          relativePath: file.relativePath,
          suggestedRole: file.suggestedRole,
          viewpointKey: file.viewpointKey,
          status: imported.deduplicated ? "deduplicated" : "imported",
          asset: imported.asset
        });
      } catch (error) {
        items.push({
          relativePath: file.relativePath,
          suggestedRole: file.suggestedRole,
          viewpointKey: file.viewpointKey,
          status: "failed",
          error: error instanceof ProtocolError ? error.message : "源文件读取或校验失败"
        });
      }
    }
    const result: ProjectFolderImportResult = {
      manifestId: manifest.id,
      importedAt: new Date().toISOString(),
      completed: items.every((item) => item.status !== "failed"),
      items
    };
    await this.log({
      at: result.importedAt,
      action: "import",
      manifestId: manifest.id,
      completed: result.completed,
      imported: items.filter((item) => item.status === "imported").length,
      deduplicated: items.filter((item) => item.status === "deduplicated").length,
      failed: items.filter((item) => item.status === "failed").length
    });
    return result;
  }

  private async persist(manifest: ProjectFolderManifest): Promise<void> {
    const destination = join(this.manifestsRoot, `${manifest.id}.json`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination);
  }

  private async log(entry: Record<string, unknown>): Promise<void> {
    await appendFile(this.logPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8" });
  }
}

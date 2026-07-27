import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import {
  ProtocolError,
  type GenerationTask,
  type ImageMime,
  type TaskAttachment,
  type TaskAttachmentInput
} from "@gpt-canvas/shared";

const MIME_BY_EXTENSION: Readonly<Record<string, ImageMime>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface AttachmentPayload {
  bytes: Buffer;
  mime: ImageMime;
  name: string;
}

function safeAssetPath(projectRoot: string, relativePath: string): string {
  const allowedRoots = [
    resolve(projectRoot, "assets"),
    resolve(projectRoot, "annotations")
  ];
  const absolute = resolve(projectRoot, relativePath);
  if (!allowedRoots.some((root) => absolute === root || absolute.startsWith(`${root}${sep}`))) {
    throw new ProtocolError("INVALID_ATTACHMENT", "附件必须位于项目 assets 或 annotations 目录内");
  }
  return absolute;
}

export async function resolveTaskAttachments(
  projectRoot: string,
  inputs: readonly TaskAttachmentInput[]
): Promise<TaskAttachment[]> {
  return Promise.all(inputs.map(async (input) => {
    const absolute = safeAssetPath(projectRoot, input.relativePath);
    const mime = MIME_BY_EXTENSION[extname(absolute).toLowerCase()];
    if (!mime) throw new ProtocolError("INVALID_ATTACHMENT", "附件只允许 PNG、JPEG 或 WebP");
    let file;
    try { file = await stat(absolute); }
    catch { throw new ProtocolError("INVALID_ATTACHMENT", `附件不存在：${input.relativePath}`); }
    if (!file.isFile() || file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) {
      throw new ProtocolError("INVALID_ATTACHMENT", "附件必须是 20 MiB 以内的非空文件");
    }
    const bytes = await readFile(absolute);
    return {
      ...input,
      id: `attachment_${randomUUID()}`,
      mime,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  }));
}

export async function readTaskAttachment(
  projectRoot: string,
  task: GenerationTask,
  attachmentId: string
): Promise<AttachmentPayload> {
  const attachment = task.attachments.find((candidate) => candidate.id === attachmentId);
  if (!attachment) throw new ProtocolError("INVALID_ATTACHMENT", "任务附件不存在");
  const absolute = safeAssetPath(projectRoot, attachment.relativePath);
  let bytes: Buffer;
  try { bytes = await readFile(absolute); }
  catch { throw new ProtocolError("INVALID_ATTACHMENT", "任务附件文件已不存在"); }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== attachment.bytes || sha256 !== attachment.sha256) {
    throw new ProtocolError("INVALID_ATTACHMENT", "任务附件已在创建后发生变化");
  }
  return { bytes, mime: attachment.mime, name: attachment.name };
}

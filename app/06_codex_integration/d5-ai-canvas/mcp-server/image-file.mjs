import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve, sep } from "node:path";

const MAX_BYTES = 40 * 1024 * 1024;

function configuredRoots() {
  const configured = process.env.D5_CANVAS_GENERATED_ROOTS?.split(";").map((item) => item.trim()).filter(Boolean) ?? [];
  return [...configured, resolve(homedir(), ".codex", "generated_images"), "D:\\CodexWorkspace"]
    .filter((value, index, values) => values.indexOf(value) === index)
    .map((value) => resolve(value));
}

function imageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  throw new Error("Generated result must be a valid PNG, JPEG, or WebP image.");
}

export async function readAuthorizedGeneratedImage(pathValue) {
  if (typeof pathValue !== "string" || !isAbsolute(pathValue)) throw new Error("generatedImagePath must be an absolute path.");
  const requested = resolve(pathValue);
  const info = await lstat(requested);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_BYTES) {
    throw new Error("Generated result must be a non-symlink image file up to 40 MiB.");
  }
  const resolvedFile = await realpath(requested);
  const realRoots = (await Promise.all(configuredRoots().map((root) => realpath(root).catch(() => null)))).filter(Boolean);
  const allowed = realRoots.some((root) => resolvedFile === root || resolvedFile.startsWith(`${root}${sep}`));
  if (!allowed) throw new Error("Generated result is outside the configured Codex output roots.");
  const bytes = await readFile(resolvedFile);
  const mime = imageMime(bytes);
  return {
    name: basename(resolvedFile),
    path: resolvedFile,
    mime,
    bytes: bytes.byteLength,
    dataUrl: `data:${mime};base64,${bytes.toString("base64")}`
  };
}

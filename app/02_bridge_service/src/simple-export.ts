import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { ProtocolError } from "@gpt-canvas/shared";
import type { ProjectRuntimeContext } from "./project-runtime-manager.js";

export async function exportSimpleImages(project: ProjectRuntimeContext, target: unknown, selections: unknown) {
  if (typeof target !== "string" || !isAbsolute(target.trim()) || dirname(resolve(target.trim())) === resolve(target.trim())) throw new ProtocolError("INVALID_INPUT", "请选择有效的导出文件夹，不能使用磁盘根目录");
  if (!Array.isArray(selections) || !selections.length || selections.length > 200) throw new ProtocolError("INVALID_INPUT", "请选择 1—200 张图片");
  const document = project.canvasProject.read();
  const versions = (document?.versions ?? []) as Array<{ id: string; assetId: string }>;
  const directory = resolve(target.trim());
  await mkdir(directory, { recursive: true });
  const records: Array<{ versionId: string; path?: string; error?: string }> = [];
  for (const selected of selections) {
    const versionId = typeof selected?.versionId === "string" ? selected.versionId : "";
    if (records.some((entry) => entry.versionId === versionId)) continue;
    try {
      const version = versions.find((entry) => entry.id === versionId);
      if (!version || version.assetId !== selected.assetId) throw new Error("图片版本与资产不匹配，请先保存画布");
      const { asset, bytes } = await project.canvasAssets.readOriginal(version.assetId);
      const name = typeof selected.name === "string" ? selected.name : asset.originalName;
      let stem = basename(name, extname(name)).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/[. ]+$/g, "").slice(0, 100) || "图片";
      if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(stem)) stem = `图片_${stem}`;
      const extension = asset.original.mime === "image/jpeg" ? ".jpg" : asset.original.mime === "image/webp" ? ".webp" : ".png";
      for (let index = 1; index < 100_000; index++) {
        const path = join(directory, `${stem}${index === 1 ? "" : `_v${index}`}${extension}`);
        try { await writeFile(path, bytes, { flag: "wx" }); records.push({ versionId, path }); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        if (index === 99_999) throw new Error("同名文件过多，请更换目录");
      }
    } catch (error) { records.push({ versionId, error: error instanceof Error ? error.message : "导出失败" }); }
  }
  const log = join(project.projectRoot, "logs", "simple-export.ndjson");
  await mkdir(dirname(log), { recursive: true });
  await appendFile(log, `${JSON.stringify({ at: new Date().toISOString(), directory, records })}\n`, "utf8");
  return { directory, records, exported: records.filter((item) => item.path).length, failed: records.filter((item) => item.error).length };
}

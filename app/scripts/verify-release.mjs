import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(appRoot, "..");
const projectRoot = resolve(process.argv[2] ?? join(appRoot, "02_bridge_service", "runtime", "default-project"));
const failures = [];
const checks = [];

function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures.push(`${name}: ${detail}`);
}

function safeProjectPath(relativePath) {
  const absolute = resolve(projectRoot, relativePath);
  if (!(absolute === projectRoot || absolute.startsWith(`${projectRoot}${sep}`))) {
    throw new Error(`路径越界：${relativePath}`);
  }
  return absolute;
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function filesRecursively(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesRecursively(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const project = JSON.parse(await readFile(join(projectRoot, "canvas", "project.json"), "utf8"));
const assetIndex = JSON.parse(await readFile(join(projectRoot, "assets", "asset-index.json"), "utf8"));
const imageNodes = project.canvas.nodes.filter((node) => node.type === "image");
const annotations = project.canvas.nodes.filter((node) => node.type !== "image");
const projectAssets = new Map(project.assets.map((asset) => [asset.id, asset]));
const indexedAssets = new Map(assetIndex.assets.map((asset) => [asset.id, asset]));
const versions = new Map(project.versions.map((version) => [version.id, version]));

check("schemaVersion", project.schemaVersion === "1.0" || project.schemaVersion === "2.0", project.schemaVersion);
check("至少 20 个图片节点", imageNodes.length >= 20, imageNodes.length);
check("批注已保存", annotations.length >= 1, annotations.length);
check("图片版本完整", project.versions.length === imageNodes.length, project.versions.length);
check(
  "画布节点 ID 唯一",
  new Set(project.canvas.nodes.map((node) => node.id)).size === project.canvas.nodes.length,
  project.canvas.nodes.length
);
check("资产分层", project.assets.every((asset) => asset.original && asset.display && asset.thumbnail), project.assets.length);
check("至少两个快照", (await readdir(join(projectRoot, "canvas", "snapshots"))).length >= 2, "canvas/snapshots");

for (const node of imageNodes) {
  const version = versions.get(node.payload.imageVersionId);
  check(`节点版本 ${node.id}`, Boolean(version), node.payload.imageVersionId);
  if (version) check(`版本资产 ${version.id}`, projectAssets.has(version.assetId), version.assetId);
}
for (const version of project.versions) {
  if (version.parentVersionId) check(`父版本 ${version.id}`, versions.has(version.parentVersionId), version.parentVersionId);
}
for (const link of project.taskLinks) {
  check(`任务父版本 ${link.taskId}`, link.parentVersionId === null || versions.has(link.parentVersionId), link.parentVersionId);
  check(`任务结果版本 ${link.taskId}`, link.resultVersionIds.every((id) => versions.has(id)), link.resultVersionIds.length);
}

for (const asset of project.assets) {
  const indexed = indexedAssets.get(asset.id);
  check(`资产索引 ${asset.id}`, Boolean(indexed), asset.id);
  for (const rendition of ["original", "display", "thumbnail"]) {
    const record = asset[rendition];
    if (!record) continue;
    const absolute = safeProjectPath(record.relativePath);
    const info = await stat(absolute).catch(() => null);
    check(`${asset.id} ${rendition} 文件`, info?.isFile() && info.size === record.bytes, record.relativePath);
    if (info?.isFile()) check(`${asset.id} ${rendition} 哈希`, await sha256(absolute) === record.sha256, record.sha256);
  }
}

const distIndex = join(appRoot, "01_canvas_app", "dist", "index.html");
check("生产画布构建", (await stat(distIndex).catch(() => null))?.isFile(), relative(workspaceRoot, distIndex));
const forbidden = /powershell.+-(?:enc|encodedcommand)|invoke-webrequest|downloadstring|new-object\s+net\.webclient|reg(?:\.exe)?\s+add.+\\run/i;
const opsRoot = join(appRoot, "05_installer_and_ops");
const unsafeScripts = [];
for (const file of (await filesRecursively(opsRoot)).filter((path) => /\.(?:ps1|cmd|bat)$/i.test(path))) {
  if (forbidden.test(await readFile(file, "utf8"))) unsafeScripts.push(relative(appRoot, file));
}
check("无高风险启动特征", unsafeScripts.length === 0, unsafeScripts);

const report = {
  ok: failures.length === 0,
  verifiedAt: new Date().toISOString(),
  projectRoot,
  summary: {
    revision: project.revision,
    imageNodes: imageNodes.length,
    annotations: annotations.length,
    assets: project.assets.length,
    versions: project.versions.length,
    snapshots: (await readdir(join(projectRoot, "canvas", "snapshots"))).length
  },
  checks,
  failures
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failures.length) process.exitCode = 1;

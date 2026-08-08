import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(process.argv[2] ?? join(appRoot, "02_bridge_service", "runtime", "default-project"));
const outputRoot = join(appRoot, "output");
await mkdir(outputRoot, { recursive: true });
const fixtureRoot = await mkdtemp(join(outputRoot, "release-verification-fixture-"));
await cp(sourceRoot, fixtureRoot, { recursive: true, errorOnExist: true });

const projectPath = join(fixtureRoot, "canvas", "project.json");
const project = JSON.parse(await readFile(projectPath, "utf8"));
const imageNodes = project.canvas.nodes.filter((node) => node.type === "image");
if (!imageNodes.length || !project.versions.length) {
  throw new Error("源项目至少需要一张已登记图片");
}

const sourceNode = imageNodes[0];
const sourceVersion = project.versions.find((version) => version.id === sourceNode.payload.imageVersionId);
if (!sourceVersion) throw new Error("源项目首张图片缺少版本记录");

for (let index = imageNodes.length; index < 20; index += 1) {
  const versionId = `version_${randomUUID()}`;
  project.versions.push({
    ...sourceVersion,
    id: versionId,
    parentVersionId: null,
    taskId: null,
    createdAt: new Date().toISOString()
  });
  project.canvas.nodes.push({
    ...sourceNode,
    id: `node_${randomUUID()}`,
    x: Number(sourceNode.x ?? 0) + (index % 5) * 24,
    y: Number(sourceNode.y ?? 0) + Math.floor(index / 5) * 24,
    zIndex: project.canvas.nodes.length,
    payload: {
      ...sourceNode.payload,
      imageVersionId: versionId,
      name: `发布校验副本_${String(index + 1).padStart(2, "0")}`
    }
  });
}

if (!project.canvas.nodes.some((node) => node.type !== "image")) {
  const annotationId = `annotation_${randomUUID()}`;
  project.canvas.nodes.push({
    id: `node_${annotationId}`,
    type: "text",
    x: 120,
    y: 80,
    width: 260,
    height: 42,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    zIndex: project.canvas.nodes.length,
    locked: false,
    visible: true,
    payload: {
      annotation: {
        id: annotationId,
        type: "text",
        x: 120,
        y: 80,
        color: "#b9472e",
        text: "V3 发布校验副本",
        width: 260,
        fontSize: 24
      }
    }
  });
}

project.revision = Number(project.revision ?? 0) + 1;
project.updatedAt = new Date().toISOString();
await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");

const snapshotsRoot = join(fixtureRoot, "canvas", "snapshots");
await mkdir(snapshotsRoot, { recursive: true });
const snapshots = await readdir(snapshotsRoot);
for (let index = snapshots.length; index < 2; index += 1) {
  await writeFile(
    join(snapshotsRoot, `verification-${index + 1}.json`),
    `${JSON.stringify(project, null, 2)}\n`,
    "utf8"
  );
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  sourceRoot,
  fixtureRoot,
  schemaVersion: project.schemaVersion,
  imageNodes: project.canvas.nodes.filter((node) => node.type === "image").length,
  annotations: project.canvas.nodes.filter((node) => node.type !== "image").length
}, null, 2)}\n`);

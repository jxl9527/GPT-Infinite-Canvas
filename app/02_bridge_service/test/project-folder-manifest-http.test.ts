import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { ProjectFolderImportResult, ProjectFolderManifest } from "@gpt-canvas/shared";
import { ProjectRuntimeManager } from "../src/project-runtime-manager.js";
import { createBridgeServer } from "../src/server.js";

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL3SAAAAABJRU5ErkJggg==",
  "base64"
);

test("本地Bridge通过受保护接口扫描、读取并导入项目文件夹清单", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-canvas-folder-http-"));
  const source = join(root, "指定项目文件夹");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "1人视.png"), pixel);
  await writeFile(join(source, "1人视_AO.png"), pixel);

  const projects = new ProjectRuntimeManager(join(root, ".runtime"), root);
  await projects.init();
  await projects.activate("project_default");
  const token = "folder-manifest-token";
  const server = createBridgeServer({
    projects,
    token,
    allowedOrigins: [],
    canvasOrigins: [],
    selectProjectFolder: async () => source
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "content-type": "application/json", "x-bridge-token": token };
  try {
    const selectResponse = await fetch(`${base}/api/v1/canvas/folder-manifests/select-folder`, {
      method: "POST",
      headers
    });
    assert.equal(selectResponse.status, 200);
    assert.deepEqual(await selectResponse.json(), { ok: true, sourceRoot: source, cancelled: false });

    const scanResponse = await fetch(`${base}/api/v1/canvas/folder-manifests/scan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sourceRoot: source, includeSubfolders: false })
    });
    assert.equal(scanResponse.status, 201);
    const manifest = (await scanResponse.json() as { manifest: ProjectFolderManifest }).manifest;
    assert.equal(manifest.fileCount, 2);
    assert.equal(manifest.importableCount, 1);

    const readResponse = await fetch(`${base}/api/v1/canvas/folder-manifests/${manifest.id}`, { headers });
    assert.equal(readResponse.status, 200);
    assert.equal((await readResponse.json() as { manifest: ProjectFolderManifest }).manifest.id, manifest.id);

    const importResponse = await fetch(`${base}/api/v1/canvas/folder-manifests/${manifest.id}/import`, {
      method: "POST",
      headers,
      body: JSON.stringify({ selectedRelativePaths: ["1人视.png"] })
    });
    assert.equal(importResponse.status, 201);
    const imported = (await importResponse.json() as { import: ProjectFolderImportResult }).import;
    assert.equal(imported.completed, true);
    assert.equal(imported.items[0]?.status, "imported");
    assert.equal(imported.items[0]?.asset?.originalName, "1人视.png");
  } finally {
    await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
  }
});

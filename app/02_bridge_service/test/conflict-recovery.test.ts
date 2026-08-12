import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { ProjectRuntimeManager } from "../src/project-runtime-manager.js";
import { createBridgeServer } from "../src/server.js";

function emptyProject(revision: number, title: string) {
  const now = new Date().toISOString();
  return {
    schemaVersion: "2.0",
    projectId: "project_00000000-0000-0000-0000-000000000771",
    title,
    createdAt: now,
    updatedAt: now,
    revision,
    canvas: { viewport: { x: 0, y: 0, scale: 1 }, nodes: [] },
    assets: [],
    versions: [],
    taskLinks: [],
    workflow: {
      activeViewpointId: null,
      viewpoints: [],
      handoffs: [],
      batchRun: null,
      customGptUrl: "",
      customGptEnabled: false,
      textCards: []
    }
  };
}

test("保存冲突时保留本地草稿并返回当前权威项目", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-canvas-conflict-recovery-"));
  const projects = new ProjectRuntimeManager(join(root, ".runtime"), root);
  await projects.init();
  await projects.activate("project_default");
  const token = "conflict-recovery-token";
  const server = createBridgeServer({ projects, token, allowedOrigins: [], canvasOrigins: [] });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "content-type": "application/json", "x-bridge-token": token };
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    return { response, json: await response.json() as Record<string, unknown> };
  };

  try {
    const initial = emptyProject(1, "初始项目");
    assert.equal((await post("/api/v1/canvas/project", { project: initial })).response.status, 200);
    const external = emptyProject(2, "Codex 已更新项目");
    assert.equal((await post("/api/v1/canvas/project", { project: external })).response.status, 200);

    const staleDraft = emptyProject(1, "设计师本地草稿");
    const rejected = await post("/api/v1/canvas/project", { project: staleDraft });
    assert.equal(rejected.response.status, 409);

    const recovered = await post("/api/v1/canvas/project/conflict-draft", { project: staleDraft });
    assert.equal(recovered.response.status, 201);
    assert.equal((recovered.json.currentProject as { revision: number }).revision, 2);
    assert.match(String(recovered.json.conflictRelativePath), /^canvas\/conflicts\/conflict_rev000001_/);
    const preserved = JSON.parse(await readFile(resolve(root, String(recovered.json.conflictRelativePath)), "utf8")) as { title: string; revision: number };
    assert.equal(preserved.title, "设计师本地草稿");
    assert.equal(preserved.revision, 1);

    const authoritative = await fetch(`${base}/api/v1/canvas/project`, { headers })
      .then((response) => response.json()) as { project: { title: string; revision: number } };
    assert.equal(authoritative.project.title, "Codex 已更新项目");
    assert.equal(authoritative.project.revision, 2);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

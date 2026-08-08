import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createCanvasStaticServer } from "../src/canvas-static-server.js";

test("正式画布静态服务只读提供构建产物并阻止路径越界", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-canvas-static-"));
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><title>GPT Canvas P2</title>", "utf8");
  await writeFile(join(root, "assets", "app.js"), "export const ready = true;", "utf8");
  const server = createCanvasStaticServer(root, "http://127.0.0.1:3999");
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const index = await fetch(base);
    assert.equal(index.status, 200);
    assert.equal(index.headers.get("x-content-type-options"), "nosniff");
    assert.match(index.headers.get("content-security-policy") ?? "", /object-src 'none'/);
    assert.match(index.headers.get("content-security-policy") ?? "", /connect-src http:\/\/127\.0\.0\.1:3999/);
    assert.match(await index.text(), /GPT Canvas P2/);
    const script = await fetch(`${base}/assets/app.js`);
    assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
    assert.equal((await fetch(base, { method: "POST" })).status, 405);
  } finally {
    await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  }
});

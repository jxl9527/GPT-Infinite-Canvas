import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("可加载产物使用 P1 端口、共享协议副本和经典内容脚本", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "dist", "manifest.json"), "utf8")) as {
    version: string; host_permissions: string[]; content_scripts: Array<{ js: string[] }>;
  };
  assert.equal(manifest.version, "1.2.0");
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1:3220/*"));
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1:3230/*"));
  assert.deepEqual(manifest.content_scripts[0]?.js, ["content/page-state.js", "content/chatgpt-adapter.js", "content/content.js"]);
  assert.deepEqual(manifest.content_scripts[1]?.js, ["content/canvas-trigger.js"]);

  const protocol = await readFile(resolve(root, "dist", "protocol.js"), "utf8");
  assert.match(protocol, /GENERATION_STATUSES/); assert.doesNotMatch(protocol, /@gpt-canvas\//);
  for (const name of ["page-state.js", "chatgpt-adapter.js", "content.js", "canvas-trigger.js"]) {
    const source = await readFile(resolve(root, "dist", "content", name), "utf8");
    assert.doesNotMatch(source, /^\s*(?:import|export)\b/m);
  }
});

test("提交实现先锁定服务端 submitted，再点击网页按钮", async () => {
  const source = await readFile(resolve(root, "dist", "content", "content.js"), "utf8");
  const committed = source.indexOf('await send("submitted"');
  const clicked = source.indexOf("button.click()", committed);
  assert.ok(committed >= 0); assert.ok(clicked > committed);
  assert.match(source, /p1-baseline:/);
  assert.match(source, /taskId: bridge\.task\.id/);
  assert.match(source, /observeAndCollect/);
  assert.doesNotMatch(source, /window\.confirm/);
  assert.match(source, /画布一键生成已授权自动提交/);
  assert.match(source, /10 \* 60_000/);
  assert.match(source, /activationMode/);
  const mounted = source.indexOf("mountPanel();");
  const stateRequested = source.indexOf('type: "adapter-get-state"');
  assert.ok(mounted >= 0 && stateRequested > mounted);
  assert.match(source, /当前标签页未绑定任务/);
  assert.match(source, /adapter-bind-current/);
  assert.match(source, /重新绑定当前任务/);
  assert.match(source, /bindingId: bridge\.bindingId/);
  assert.match(source, /自动桥接初始化失败/);
  const canvasTrigger = await readFile(resolve(root, "dist", "content", "canvas-trigger.js"), "utf8");
  assert.match(canvasTrigger, /gpt-canvas-run-task/);
  assert.match(canvasTrigger, /canvas-task-completed/);
});

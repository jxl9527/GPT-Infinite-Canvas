import { spawn, spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

const bundleRoot = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("请提供已解压的发布包根目录");

const bridgePort = Number(process.env.GPT_CANVAS_SMOKE_BRIDGE_PORT ?? 3320);
const canvasPort = Number(process.env.GPT_CANVAS_SMOKE_UI_PORT ?? 3330);
const runtimeRoot = join(bundleRoot, "runtime-smoke");
const serviceEntry = join(bundleRoot, "02_bridge_service", "dist", "src", "main.js");
const canvasDistRoot = join(bundleRoot, "01_canvas_app", "dist");

await access(serviceEntry);
await access(join(canvasDistRoot, "index.html"));

const child = spawn(process.execPath, [serviceEntry], {
  cwd: join(bundleRoot, "02_bridge_service"),
  env: {
    ...process.env,
    GPT_CANVAS_PORT: String(bridgePort),
    GPT_CANVAS_UI_PORT: String(canvasPort),
    GPT_CANVAS_RUNTIME_ROOT: runtimeRoot,
    GPT_CANVAS_PROJECT_ROOT: join(runtimeRoot, "default-project"),
    GPT_CANVAS_DIST_ROOT: canvasDistRoot
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let output = "";
child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-4_000); });
child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-4_000); });

async function waitForHealth() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`发布包服务提前退出：${output.trim()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${bridgePort}/health`);
      const body = await response.json();
      if (response.ok && body.ok === true) return body;
    } catch {
      // The isolated service is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`发布包服务未在 10 秒内就绪：${output.trim()}`);
}

async function waitForCanvas() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${canvasPort}/`);
      if (response.ok) return response;
    } catch {
      // The static server starts immediately after the bridge listener.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`发布包画布未在 5 秒内就绪：${output.trim()}`);
}

try {
  const health = await waitForHealth();
  const canvas = await waitForCanvas();
  await access(join(runtimeRoot, "bridge-token.txt"));
  process.stdout.write(`${JSON.stringify({
    ok: true,
    bridgePort,
    canvasPort,
    schemaVersion: health.schemaVersion,
    canvasStatus: canvas.status,
    runtimeTokenCreated: true
  }, null, 2)}\n`);
} finally {
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
    ]);
    if (child.exitCode === null && child.pid) {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
    }
  }
}

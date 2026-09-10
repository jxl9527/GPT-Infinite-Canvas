import { spawn, spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const bundleRoot = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("请提供已解压的发布包根目录");

const bridgePort = Number(process.env.GPT_CANVAS_SMOKE_BRIDGE_PORT ?? 3320);
const canvasPort = Number(process.env.GPT_CANVAS_SMOKE_UI_PORT ?? 3330);
const runtimeRoot = join(bundleRoot, "runtime-smoke");
const serviceEntry = join(bundleRoot, "02_bridge_service", "dist", "src", "main.js");
const canvasDistRoot = join(bundleRoot, "01_canvas_app", "dist");
const releaseManifest = JSON.parse(await readFile(join(bundleRoot, "release-manifest.json"), "utf8"));
const packageMetadata = JSON.parse(await readFile(join(bundleRoot, "package.json"), "utf8"));
const pluginMetadata = JSON.parse(await readFile(join(bundleRoot, "06_codex_integration", "d5-ai-canvas", "package.json"), "utf8"));
const pluginDescriptor = JSON.parse(await readFile(join(bundleRoot, "06_codex_integration", "d5-ai-canvas", ".codex-plugin", "plugin.json"), "utf8"));
const expectedReleaseVersion = releaseManifest.releaseVersion;
if (
  packageMetadata.version !== expectedReleaseVersion
  || pluginMetadata.version !== expectedReleaseVersion
  || pluginDescriptor.version !== expectedReleaseVersion
) {
  throw new Error(`发布清单、应用与 Codex 插件版本不一致：manifest=${expectedReleaseVersion} app=${packageMetadata.version} plugin=${pluginMetadata.version} descriptor=${pluginDescriptor.version}`);
}

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
    GPT_CANVAS_DIST_ROOT: canvasDistRoot,
    GPT_CANVAS_DISCOVERY_PATH: join(runtimeRoot, "bridge-connection.json")
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
  if (health.releaseVersion !== expectedReleaseVersion) {
    throw new Error(`发布包版本与运行服务不一致：expected=${expectedReleaseVersion} actual=${health.releaseVersion ?? "missing"}`);
  }
  const canvas = await waitForCanvas();
  const tokenPath = join(runtimeRoot, "bridge-token.txt");
  await access(tokenPath);
  const token = (await readFile(tokenPath, "utf8")).trim();
  const projectListResponse = await fetch(`http://127.0.0.1:${bridgePort}/api/v1/workbench/projects`, {
    headers: { "x-bridge-token": token }
  });
  const projectList = await projectListResponse.json();
  let projectId = projectList.projects?.[0]?.id;
  if (!projectListResponse.ok) throw new Error("发布包项目登记接口不可用");
  if (!projectId) {
    const createdResponse = await fetch(`http://127.0.0.1:${bridgePort}/api/v1/workbench/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-token": token },
      body: JSON.stringify({ name: "发布包隔离冒烟" })
    });
    const created = await createdResponse.json();
    projectId = created.project?.id;
    if (!createdResponse.ok || !projectId) throw new Error("发布包无法创建隔离冒烟项目");
  }
  const activateResponse = await fetch(`http://127.0.0.1:${bridgePort}/api/v1/workbench/projects/${encodeURIComponent(projectId)}/activate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bridge-token": token },
    body: "{}"
  });
  if (!activateResponse.ok) throw new Error("发布包默认项目激活失败");
  const pluginRoot = join(bundleRoot, "06_codex_integration", "d5-ai-canvas");
  await access(join(pluginRoot, "scripts", "start-mcp.mjs"));
  const pluginProbe = spawnSync(process.execPath, [join(pluginRoot, "scripts", "probe-mcp.mjs")], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      D5_CANVAS_BRIDGE_URL: `http://127.0.0.1:${bridgePort}`,
      D5_CANVAS_RUNTIME_ROOT: runtimeRoot,
      D5_CANVAS_DISCOVERY_PATH: join(runtimeRoot, "bridge-connection.json"),
      D5_CANVAS_PROBE_BRIDGE: "1"
    },
    encoding: "utf8",
    windowsHide: true
  });
  if (pluginProbe.status !== 0) throw new Error(pluginProbe.stderr || "发布包 Codex MCP 实桥探针失败");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    bridgePort,
    canvasPort,
    schemaVersion: health.schemaVersion,
    releaseVersion: health.releaseVersion,
    canvasStatus: canvas.status,
    runtimeTokenCreated: true,
    codexMcpTools: 12,
    codexBridgeProbe: true
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

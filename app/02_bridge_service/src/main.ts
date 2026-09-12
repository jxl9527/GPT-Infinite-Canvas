import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createCanvasStaticServer } from "./canvas-static-server.js";
import { selectNativeProjectFolder } from "./native-folder-picker.js";
import { ProjectRuntimeManager } from "./project-runtime-manager.js";
import { createBridgeServer } from "./server.js";

const host = "127.0.0.1";
const port = Number(process.env.GPT_CANVAS_PORT ?? 3220);
const canvasPort = Number(process.env.GPT_CANVAS_UI_PORT ?? 3230);
const projectRoot = resolve(process.env.GPT_CANVAS_PROJECT_ROOT ?? "runtime/default-project");
const runtimeRoot = resolve(process.env.GPT_CANVAS_RUNTIME_ROOT ?? "runtime");
const canvasDistRoot = resolve(process.env.GPT_CANVAS_DIST_ROOT ?? "../01_canvas_app/dist");
const discoveryPath = resolve(
  process.env.GPT_CANVAS_DISCOVERY_PATH
    ?? resolve(process.env.LOCALAPPDATA ?? runtimeRoot, "D5AICanvas", "bridge-connection.json")
);
await mkdir(runtimeRoot, { recursive: true });
const tokenPath = resolve(runtimeRoot, "bridge-token.txt");
let token: string;
try { token = (await readFile(tokenPath, "utf8")).trim(); }
catch {
  token = randomBytes(24).toString("base64url");
  await writeFile(tokenPath, `${token}\n`, { encoding: "utf8", flag: "wx" });
}

const projects = new ProjectRuntimeManager(runtimeRoot, projectRoot); await projects.init();
await mkdir(resolve(discoveryPath, ".."), { recursive: true });
const discoveryTemporary = `${discoveryPath}.${process.pid}.tmp`;
await writeFile(discoveryTemporary, `${JSON.stringify({
  schemaVersion: "1.0",
  releaseVersion: "0.6.0",
  bridgeUrl: `http://${host}:${port}`,
  canvasUrl: `http://${host}:${canvasPort}`,
  runtimeRoot,
  updatedAt: new Date().toISOString()
}, null, 2)}\n`, { encoding: "utf8", flag: "w" });
await rename(discoveryTemporary, discoveryPath);
const server = createBridgeServer({
  projects,
  token,
  selectProjectFolder: selectNativeProjectFolder,
  canvasOrigins: [
    `http://${host}:${canvasPort}`,
    `http://localhost:${canvasPort}`,
    "http://127.0.0.1:3230",
    "http://localhost:3230"
  ],
  allowedOrigins: [
    `http://${host}:${canvasPort}`,
    `http://localhost:${canvasPort}`,
    "http://127.0.0.1:3230",
    "http://localhost:3230",
    "https://chatgpt.com",
    "https://chat.openai.com",
    "https://labs.google"
  ]
});
server.listen(port, host, async () => {
  await writeFile(resolve(runtimeRoot, "service.pid"), `${process.pid}\n`, "utf8");
  process.stdout.write(`GPT Canvas Bridge 0.6.0 listening at http://${host}:${port}\n`);
});

try {
  await access(resolve(canvasDistRoot, "index.html"));
  const canvasServer = createCanvasStaticServer(canvasDistRoot, `http://${host}:${port}`);
  canvasServer.listen(canvasPort, host, () => {
    process.stdout.write(`GPT Canvas P2 listening at http://${host}:${canvasPort}\n`);
  });
} catch {
  process.stdout.write(`GPT Canvas P2 static build not found at ${canvasDistRoot}; bridge only.\n`);
}

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const discoveryPath = process.env.D5_CANVAS_DISCOVERY_PATH?.trim()
  || resolve(process.env.LOCALAPPDATA || pluginRoot, "D5AICanvas", "bridge-connection.json");
const discovery = await readFile(discoveryPath, "utf8")
  .then((text) => JSON.parse(text))
  .catch(() => null);

function discoveredRuntimeRoot() {
  return typeof discovery?.runtimeRoot === "string" && isAbsolute(discovery.runtimeRoot)
    ? resolve(discovery.runtimeRoot)
    : null;
}

function runtimeRoot() {
  const configured = process.env.D5_CANVAS_RUNTIME_ROOT?.trim();
  if (!configured) return discoveredRuntimeRoot() || resolve(pluginRoot, "../../02_bridge_service/runtime");
  return isAbsolute(configured) ? resolve(configured) : resolve(pluginRoot, configured);
}

export function bridgeBaseUrl() {
  const discoveredUrl = typeof discovery?.bridgeUrl === "string" && /^http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}\/?$/.test(discovery.bridgeUrl)
    ? discovery.bridgeUrl
    : "";
  return (process.env.D5_CANVAS_BRIDGE_URL?.trim() || discoveredUrl || "http://127.0.0.1:3220").replace(/\/$/, "");
}

async function bridgeToken() {
  if (process.env.D5_CANVAS_BRIDGE_TOKEN?.trim()) return process.env.D5_CANVAS_BRIDGE_TOKEN.trim();
  const configured = process.env.D5_CANVAS_TOKEN_FILE?.trim();
  const tokenPath = configured
    ? (isAbsolute(configured) ? resolve(configured) : resolve(pluginRoot, configured))
    : resolve(runtimeRoot(), "bridge-token.txt");
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (!token) throw new Error(`D5 AI Canvas token file is empty: ${tokenPath}`);
  return token;
}

export async function bridgeRequest(path, options = {}) {
  const headers = { accept: "application/json", ...(options.body === undefined ? {} : { "content-type": "application/json" }) };
  if (path !== "/health") headers["x-bridge-token"] = await bridgeToken();
  const response = await fetch(`${bridgeBaseUrl()}${path}`, {
    method: options.method || (options.body === undefined ? "GET" : "POST"),
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });
  const payload = await response.json().catch(() => ({ ok: false, error: { message: `HTTP ${response.status}` } }));
  if (!response.ok) {
    const message = payload?.error?.message || `D5 AI Canvas bridge returned HTTP ${response.status}`;
    const error = new Error(message);
    error.code = payload?.error?.code || "BRIDGE_ERROR";
    error.status = response.status;
    throw error;
  }
  return payload;
}

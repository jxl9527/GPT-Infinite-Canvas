import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const child = spawn(process.execPath, [resolve(pluginRoot, "scripts/start-mcp.mjs")], {
  cwd: pluginRoot,
  stdio: ["pipe", "pipe", "pipe"]
});

let output = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.pipe(process.stderr);

child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "d5-probe", version: "1.0.0" } } })}\n`);
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
const probeBridge = process.env.D5_CANVAS_PROBE_BRIDGE === "1";
if (probeBridge) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "d5_get_capabilities", arguments: {} } })}\n`);
}

const deadline = setTimeout(() => {
  child.kill();
  process.stderr.write("MCP probe timed out.\n");
  process.exitCode = 1;
}, 5_000);

child.stdout.on("data", () => {
  if (!output.includes('"id":2') || (probeBridge && !output.includes('"id":3'))) return;
  clearTimeout(deadline);
  const lines = output.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const tools = lines.find((line) => line.id === 2)?.result?.tools ?? [];
  const names = tools.map((tool) => tool.name);
  const required = ["d5_get_capabilities", "d5_scan_project_folder", "d5_import_manifest", "d5_get_workflow_state", "d5_create_run", "d5_register_text_card", "d5_get_run_item_inputs", "d5_mark_generation_submitted", "d5_register_generated_result", "d5_pause_run", "d5_resume_run", "d5_handoff_run_items"];
  const missing = required.filter((name) => !names.includes(name));
  const capabilityResult = probeBridge ? lines.find((line) => line.id === 3)?.result : null;
  if (missing.length) {
    process.stderr.write(`MCP probe missing tools: ${missing.join(", ")}\n`);
    process.exitCode = 1;
  } else if (probeBridge && (capabilityResult?.isError === true || capabilityResult?.structuredContent?.ok !== true)) {
    process.stderr.write("MCP bridge capability call failed.\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(`MCP probe passed with ${names.length} tools${probeBridge ? " and a live bridge call" : ""}.\n`);
  }
  child.kill();
});

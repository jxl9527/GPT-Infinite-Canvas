import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(appRoot, "..");
const packageMetadata = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));
const commandArguments = process.argv.slice(2);
const validateOnly = commandArguments.includes("--validate-only");
const requestedVersion = commandArguments.find((argument) => argument !== "--validate-only");
const version = requestedVersion ?? packageMetadata.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`版本号无效：${version}`);
if (version !== packageMetadata.version) {
  throw new Error(`请求打包版本 ${version} 与 app/package.json ${packageMetadata.version} 不一致；请先完成正式版本升级`);
}

async function assertVersionMarkers(relativePath, pattern) {
  const content = await readFile(join(appRoot, relativePath), "utf8");
  const found = [...content.matchAll(pattern)].map((match) => match[1]);
  if (!found.length || found.some((candidate) => candidate !== version)) {
    throw new Error(`${relativePath} 的发布版本面不一致：${found.join(", ") || "未找到"}`);
  }
}

await assertVersionMarkers("02_bridge_service/src/server.ts", /(?:releaseVersion|bridgeVersion):\s*"(\d+\.\d+\.\d+)"/g);
await assertVersionMarkers("02_bridge_service/src/main.ts", /releaseVersion:\s*"(\d+\.\d+\.\d+)"/g);
await assertVersionMarkers("02_bridge_service/src/main.ts", /GPT Canvas Bridge (\d+\.\d+\.\d+) listening/g);
await assertVersionMarkers("05_installer_and_ops/Start-GPTInfiniteCanvas-Chrome.ps1", /\$expectedReleaseVersion\s*=\s*'(\d+\.\d+\.\d+)'/g);
await assertVersionMarkers("05_installer_and_ops/Install-GPTInfiniteCanvas-DesktopLauncher.ps1", /version="(\d+\.\d+\.\d+)"/g);
await assertVersionMarkers("05_installer_and_ops/Install-GPTInfiniteCanvas-DesktopLauncher.ps1", /GPT Infinite Canvas (\d+\.\d+\.\d+)｜浏览器人工批量／Codex 自动运行/g);
await assertVersionMarkers("06_codex_integration/d5-ai-canvas/mcp-server/server.mjs", /name:\s*"d5-ai-canvas",\s*version:\s*"(\d+\.\d+\.\d+)"/g);
const pluginMetadata = JSON.parse(await readFile(join(appRoot, "06_codex_integration", "d5-ai-canvas", "package.json"), "utf8"));
const pluginLockMetadata = JSON.parse(await readFile(join(appRoot, "06_codex_integration", "d5-ai-canvas", "package-lock.json"), "utf8"));
const pluginDescriptor = JSON.parse(await readFile(join(appRoot, "06_codex_integration", "d5-ai-canvas", ".codex-plugin", "plugin.json"), "utf8"));
if (
  pluginMetadata.version !== version
  || pluginLockMetadata.version !== version
  || pluginLockMetadata.packages?.[""]?.version !== version
  || pluginDescriptor.version !== version
) {
  throw new Error(`Codex 插件版本面与发布版本 ${version} 不一致`);
}
if (validateOnly) {
  process.stdout.write(`${JSON.stringify({ valid: true, releaseVersion: version, versionSurfaces: 10 }, null, 2)}\n`);
  process.exit(0);
}
const bundleName = `GPT_Infinite_Canvas_${version}`;
const releaseRoot = join(workspaceRoot, "releases");
const temporaryRoot = await mkdtemp(join(tmpdir(), "gpt-infinite-canvas-release-"));
const bundleRoot = join(temporaryRoot, bundleName);

async function copy(source, destination) {
  const info = await stat(source);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: info.isDirectory(), errorOnExist: true });
}

async function filesRecursively(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesRecursively(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

try {
  await mkdir(bundleRoot, { recursive: true });
  for (const name of ["package.json", "package-lock.json"]) {
    await copy(join(appRoot, name), join(bundleRoot, name));
  }
  for (const workspace of ["01_canvas_app", "02_bridge_service", "03_browser_extension", "04_shared_packages"]) {
    const sourceRoot = join(appRoot, workspace);
    const targetRoot = join(bundleRoot, workspace);
    await copy(join(sourceRoot, "package.json"), join(targetRoot, "package.json"));
    await copy(join(sourceRoot, "dist"), join(targetRoot, "dist"));
    const readme = join(sourceRoot, "README.md");
    if ((await stat(readme).catch(() => null))?.isFile()) await copy(readme, join(targetRoot, "README.md"));
  }
  await copy(join(appRoot, "06_codex_integration"), join(bundleRoot, "06_codex_integration"));
  const packagedSharedRoot = join(bundleRoot, "node_modules", "@gpt-canvas", "shared");
  await copy(
    join(appRoot, "04_shared_packages", "package.json"),
    join(packagedSharedRoot, "package.json")
  );
  await copy(
    join(appRoot, "04_shared_packages", "dist"),
    join(packagedSharedRoot, "dist")
  );
  for (const name of [
    "Start-GPTCanvas.cmd",
    "Start-GPTCanvas.vbs",
    "Start-GPTInfiniteCanvas-Chrome.ps1",
    "Start-GPTInfiniteCanvas-Chrome.vbs",
    "Install-GPTInfiniteCanvas-DesktopLauncher.cmd",
    "Install-GPTInfiniteCanvas-DesktopLauncher.ps1",
    "Run-GPTCanvas-Service.cmd",
    "Stop-GPTCanvas.vbs",
    "Backup-P1Project.ps1",
    "Restore-P1Project.ps1",
    "Export-P1Diagnostics.ps1",
    "Install-D5AICanvas-CodexPlugin.ps1"
  ]) {
    await copy(
      join(appRoot, "05_installer_and_ops", name),
      join(bundleRoot, "05_installer_and_ops", name)
    );
  }
  await copy(
    join(appRoot, "05_installer_and_ops", "assets", "launcher"),
    join(bundleRoot, "05_installer_and_ops", "assets", "launcher")
  );
  await copy(
    join(workspaceRoot, "docs", "guides", "安装与使用.md"),
    join(bundleRoot, "README.md")
  );
  for (const name of ["简化版验收说明.md", "提示词内容包说明.md", "无限画布简化改版项目计划书.md"]) {
    await copy(join(workspaceRoot, "docs", name), join(bundleRoot, "docs", name));
  }
  await copy(join(appRoot, "scripts", "create-prompt-pack.mjs"), join(bundleRoot, "scripts", "create-prompt-pack.mjs"));
  const runtimeDependencyCheck = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", 'await import("@gpt-canvas/shared")'],
    { cwd: bundleRoot, encoding: "utf8", windowsHide: true }
  );
  if (runtimeDependencyCheck.status !== 0) {
    throw new Error(runtimeDependencyCheck.stderr || "发布包共享运行库解析失败");
  }
  const pluginProbe = spawnSync(
    process.execPath,
    ["scripts/probe-mcp.mjs"],
    { cwd: join(bundleRoot, "06_codex_integration", "d5-ai-canvas"), encoding: "utf8", windowsHide: true }
  );
  if (pluginProbe.status !== 0) {
    throw new Error(pluginProbe.stderr || "发布包 Codex MCP 协议探针失败");
  }
  const files = [];
  for (const path of (await filesRecursively(bundleRoot)).sort()) {
    const bytes = await readFile(path);
    files.push({
      relativePath: relative(bundleRoot, path).replaceAll("\\", "/"),
      bytes: bytes.byteLength,
      sha256: sha256(bytes)
    });
  }
  const manifest = {
    schemaVersion: "1.0",
    releaseVersion: version,
    createdAt: new Date().toISOString(),
    nodeMinimum: "24.0.0",
    entrypoint: "05_installer_and_ops/Start-GPTInfiniteCanvas-Chrome.vbs",
    desktopInstaller: "05_installer_and_ops/Install-GPTInfiniteCanvas-DesktopLauncher.cmd",
    desktopInstallerScript: "05_installer_and_ops/Install-GPTInfiniteCanvas-DesktopLauncher.ps1",
    codexPluginInstaller: "05_installer_and_ops/Install-D5AICanvas-CodexPlugin.ps1",
    codexPlugin: "06_codex_integration/d5-ai-canvas",
    legacyEntrypoint: "05_installer_and_ops/Start-GPTCanvas.vbs",
    endpoints: {
      canvas: "http://127.0.0.1:3230",
      bridge: "http://127.0.0.1:3220"
    },
    files
  };
  await writeFile(join(bundleRoot, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  await mkdir(releaseRoot, { recursive: true });
  let archive = join(releaseRoot, `${bundleName}.zip`);
  let suffix = 2;
  while ((await stat(archive).catch(() => null))?.isFile()) {
    archive = join(releaseRoot, `${bundleName}_v${suffix}.zip`);
    suffix += 1;
  }
  const packed = spawnSync("tar.exe", ["-a", "-c", "-f", archive, "-C", temporaryRoot, bundleName], {
    encoding: "utf8",
    windowsHide: false
  });
  if (packed.status !== 0) throw new Error(packed.stderr || "tar.exe 打包失败");
  const archiveBytes = await readFile(archive);
  process.stdout.write(`${JSON.stringify({
    packaged: true,
    archive,
    bytes: archiveBytes.byteLength,
    sha256: sha256(archiveBytes),
    bundleName,
    fileCount: files.length + 1
  }, null, 2)}\n`);
} finally {
  const resolvedTemporary = resolve(temporaryRoot);
  const allowedRoot = resolve(tmpdir());
  if (resolvedTemporary.startsWith(`${allowedRoot}\\`) && basename(resolvedTemporary).startsWith("gpt-infinite-canvas-release-")) {
    await rm(resolvedTemporary, { recursive: true, force: true });
  }
}

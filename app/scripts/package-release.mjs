import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(appRoot, "..");
const version = process.argv[2] ?? "0.3.0";
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`版本号无效：${version}`);
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
    "Export-P1Diagnostics.ps1"
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
  const runtimeDependencyCheck = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", 'await import("@gpt-canvas/shared")'],
    { cwd: bundleRoot, encoding: "utf8", windowsHide: true }
  );
  if (runtimeDependencyCheck.status !== 0) {
    throw new Error(runtimeDependencyCheck.stderr || "发布包共享运行库解析失败");
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

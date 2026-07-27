import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = resolve(extensionRoot, "..");
const distRoot = resolve(extensionRoot, "dist");
const buildRoot = resolve(extensionRoot, ".build");
if (dirname(distRoot) !== extensionRoot || basename(distRoot) !== "dist") throw new Error("扩展输出目录校验失败");
await rm(distRoot, { recursive: true, force: true });
await rm(buildRoot, { recursive: true, force: true });

const tsc = resolve(appRoot, "node_modules", "typescript", "bin", "tsc");
for (const config of ["tsconfig.json", "tsconfig.content.json"]) {
  const run = spawnSync(process.execPath, [tsc, "-p", resolve(extensionRoot, config), "--pretty", "false"], { cwd: extensionRoot, stdio: "inherit" });
  if (run.status !== 0) process.exit(run.status ?? 1);
}

await mkdir(join(distRoot, "content"), { recursive: true });
for (const file of ["background.js", "background-guards.js", "popup.js"]) {
  await cp(join(buildRoot, "module", file), join(distRoot, file));
}
for (const file of ["page-state.js", "chatgpt-adapter.js", "content.js", "canvas-trigger.js"]) {
  await cp(join(buildRoot, "content", file), join(distRoot, "content", file));
}
for (const file of ["manifest.json", "popup.html", "popup.css"]) await cp(join(extensionRoot, file), join(distRoot, file));
await cp(resolve(appRoot, "04_shared_packages", "dist", "src", "index.js"), join(distRoot, "protocol.js"));

const javascriptFiles = (await readdir(distRoot, { recursive: true }))
  .filter((file) => typeof file === "string" && file.endsWith(".js"));
for (const file of javascriptFiles) {
  const absolute = join(distRoot, file); const source = await readFile(absolute, "utf8");
  if (source.includes("@gpt-canvas/")) throw new Error(`扩展产物仍含裸包导入：${relative(distRoot, absolute)}`);
  if (absolute.includes(`${sep}content${sep}`) && /^\s*(?:import|export)\b/m.test(source)) {
    throw new Error(`内容脚本不是经典脚本：${relative(distRoot, absolute)}`);
  }
  await writeFile(absolute, source.replaceAll("//# sourceMappingURL=", "// source map omitted: "), "utf8");
}
process.stdout.write(`P1 extension built: ${distRoot}\n`);

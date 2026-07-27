import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
for (const name of ["dist", ".build", ".test-dist"]) {
  const target = resolve(root, name);
  if (dirname(target) !== root || basename(target) !== name) throw new Error(`拒绝清理非预期目录：${target}`);
  await rm(target, { recursive: true, force: true });
}

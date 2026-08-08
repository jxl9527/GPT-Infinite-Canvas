import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("中键拖动画布时实时同步文字卡视口", async () => {
  const source = await readFile(resolve(root, "src", "App.tsx"), "utf8");
  const dragMoveStart = source.indexOf("onDragMove={(event) => {");
  const dragEndStart = source.indexOf("onDragEnd={(event) => {", dragMoveStart);
  assert.ok(dragMoveStart >= 0 && dragEndStart > dragMoveStart);
  const dragMove = source.slice(dragMoveStart, dragEndStart);
  assert.match(dragMove, /middlePanningRef\.current/);
  assert.match(dragMove, /setViewport/);
  assert.match(dragMove, /event\.target\.x\(\)/);
  assert.match(dragMove, /event\.target\.y\(\)/);
});

test("中键和文字卡拖动在窗口外松开时都能结束", async () => {
  const source = await readFile(resolve(root, "src", "App.tsx"), "utf8");

  assert.match(source, /window\.addEventListener\("mouseup", releaseOutsideCanvas\)/);
  assert.match(source, /window\.addEventListener\("blur", releaseWhenWindowLosesFocus\)/);
  assert.match(source, /window\.addEventListener\("blur", end\)/);
  assert.match(source, /window\.removeEventListener\("blur", end\)/);
});

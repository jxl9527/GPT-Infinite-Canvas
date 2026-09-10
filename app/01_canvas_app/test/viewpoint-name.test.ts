import assert from "node:assert/strict";
import test from "node:test";
import { MAX_VIEWPOINT_NAME_LENGTH } from "@gpt-canvas/shared";
import { viewpointNameFromFilename } from "../src/viewpoint-name.js";

test("短文件名直接转为视角名并移除D5通道后缀", () => {
  assert.equal(viewpointNameFromFilename("厂房东南角_Reflection.png"), "厂房东南角");
});

test("长文件名生成的视角名不超过服务端保存上限", () => {
  const name = viewpointNameFromFilename("codex-clipboard-6f220e0b-c535-43f6-8998-2320b5cbcd67.png");
  assert.ok(name.length <= MAX_VIEWPOINT_NAME_LENGTH);
  assert.equal(name.endsWith("…"), true);
});

test("截断视角名不会留下不完整的代理字符", () => {
  const name = viewpointNameFromFilename(`${"厂房".repeat(20)}😀.png`);
  assert.ok(name.length <= MAX_VIEWPOINT_NAME_LENGTH);
  assert.equal(/[\uD800-\uDBFF]$/.test(name.slice(0, -1)), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import { containsFolderFiles, naturalSortImportFiles } from "../src/folder-import.js";

test("文件夹图片按相对路径和数字自然排序", () => {
  const sorted = naturalSortImportFiles([
    { name: "D5_10.png", webkitRelativePath: "效果图/D5_10.png" },
    { name: "D5_2.png", webkitRelativePath: "效果图/D5_2.png" },
    { name: "D5_1.png", webkitRelativePath: "效果图/D5_1.png" }
  ]);
  assert.deepEqual(sorted.map((item) => item.name), ["D5_1.png", "D5_2.png", "D5_10.png"]);
});

test("带相对路径的文件始终识别为文件夹导入", () => {
  assert.equal(containsFolderFiles([
    { name: "1人视.png", webkitRelativePath: "D5_01/1人视.png" }
  ]), true);
  assert.equal(containsFolderFiles([{ name: "1人视.png" }]), false);
});

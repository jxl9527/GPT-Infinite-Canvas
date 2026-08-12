import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { CanvasAssetRepository } from "../src/canvas-asset-repository.js";
import { ProjectFolderManifestService } from "../src/project-folder-manifest.js";

const pixelBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL3SAAAAABJRU5ErkJggg==";
const pixel = Buffer.from(pixelBase64, "base64");

async function setup(): Promise<{
  root: string;
  source: string;
  assets: CanvasAssetRepository;
  service: ProjectFolderManifestService;
}> {
  const root = await mkdtemp(join(tmpdir(), "gpt-canvas-folder-manifest-"));
  const source = join(root, "用户指定效果图");
  await mkdir(join(source, "补充批次"), { recursive: true });
  for (const name of ["D5_2.png", "D5_10.png", "D5_2_SU.png", "风格参考.png", "D5_2_AO.png"]) {
    await writeFile(join(source, name), pixel);
  }
  await writeFile(join(source, "补充批次", "D5_3.png"), pixel);
  const assets = new CanvasAssetRepository(join(root, "canvas-project"));
  await assets.init();
  const service = new ProjectFolderManifestService(join(root, "canvas-project"), assets);
  await service.init();
  return { root, source, assets, service };
}

test("项目文件夹只读扫描按自然顺序识别D5、SU、风格参考和后期通道", async () => {
  const { source, service } = await setup();
  const manifest = await service.scan(source, false);
  assert.equal(manifest.fileCount, 5);
  assert.equal(manifest.importableCount, 4);
  const names = manifest.files.map((file) => file.name);
  assert.deepEqual(new Set(names), new Set([
    "D5_2.png",
    "D5_2_AO.png",
    "D5_2_SU.png",
    "D5_10.png",
    "风格参考.png"
  ]));
  assert.ok(names.indexOf("D5_2.png") < names.indexOf("D5_10.png"));
  assert.equal(manifest.files.find((file) => file.name === "D5_2.png")?.suggestedRole, "d5-view");
  assert.equal(manifest.files.find((file) => file.name === "D5_2_SU.png")?.suggestedRole, "su-reference");
  assert.equal(manifest.files.find((file) => file.name === "风格参考.png")?.suggestedRole, "style-reference");
  const ao = manifest.files.find((file) => file.name === "D5_2_AO.png");
  assert.equal(ao?.suggestedRole, "ignored-channel");
  assert.equal(ao?.importable, false);
  assert.match(ao?.reason ?? "", /通道图/);
  assert.deepEqual(await readFile(join(source, "D5_2.png")), pixel);

  const recursive = await service.scan(source, true);
  assert.equal(recursive.fileCount, 6);
  assert.ok(recursive.files.some((file) => file.relativePath === "补充批次/D5_3.png"));
});

test("清单导入复制资产、重复内容去重且源文件保持不变", async () => {
  const { source, assets, service } = await setup();
  const manifest = await service.scan(source, false);
  const selected = ["D5_2.png", "D5_2_SU.png"];
  const first = await service.importManifest(manifest.id, selected);
  assert.equal(first.completed, true);
  assert.equal(first.items.length, 2);
  assert.equal(first.items.filter((item) => item.status === "imported").length, 1);
  assert.equal(first.items.filter((item) => item.status === "deduplicated").length, 1);
  assert.equal(assets.list().length, 1);
  assert.deepEqual(await readFile(join(source, "D5_2.png")), pixel);

  const second = await service.importManifest(manifest.id, selected);
  assert.equal(second.items.every((item) => item.status === "deduplicated"), true);
  assert.equal(assets.list().length, 1);
});

test("源图片在确认清单后变化时拒绝导入且保留失败记录", async () => {
  const { source, assets, service } = await setup();
  const manifest = await service.scan(source, false);
  await writeFile(join(source, "D5_10.png"), Buffer.concat([pixel, Buffer.from("changed")]));
  const result = await service.importManifest(manifest.id, ["D5_10.png"]);
  assert.equal(result.completed, false);
  assert.equal(result.items[0]?.status, "failed");
  assert.match(result.items[0]?.error ?? "", /发生变化/);
  assert.equal(assets.list().length, 0);
});

test("项目文件夹扫描拒绝磁盘根目录和清单外路径", async () => {
  const { source, service } = await setup();
  await assert.rejects(() => service.scan(parse(source).root, false), /磁盘根目录/);
  const manifest = await service.scan(source, false);
  await assert.rejects(() => service.importManifest(manifest.id, ["不存在.png"]), /清单中不存在/);
});

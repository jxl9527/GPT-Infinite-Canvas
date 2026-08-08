import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanvasAssetRepository } from "../src/canvas-asset-repository.js";
import { DeliveryRepository } from "../src/delivery-repository.js";
import { TaskStore } from "../src/task-store.js";

const pixelBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL3SAAAAABJRU5ErkJggg==";
const dataUrl = `data:image/png;base64,${pixelBase64}`;

test("正式归档按 D5 规则顺延版本、保存提示词、区分玻璃整图并去重", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-canvas-delivery-"));
  const effectsRoot = join(root, "正式项目", "01投标阶段", "效果图");
  const aiRoot = join(effectsRoot, "AI");
  await mkdir(effectsRoot, { recursive: true });
  const assets = new CanvasAssetRepository(root); await assets.init();
  const store = new TaskStore(root); await store.init();
  const delivery = new DeliveryRepository(root, assets, store); await delivery.init();
  const generated = await assets.saveGeneratedAsset("专属GPT结果.png", dataUrl);
  const task = await store.create({
    taskType: "edit",
    responseMode: "image",
    target: { chatMode: "new" },
    prompt: "保持建筑体块、层数、门窗、道路和场地边界完全不变。",
    attachments: []
  }, []);

  const target = await delivery.saveTarget(aiRoot);
  assert.equal(target.aiDirectory, aiRoot);
  assert.equal((await stat(join(effectsRoot, "成图"))).isDirectory(), true);
  await writeFile(join(aiRoot, "1人视_01.png"), "existing", "utf8");

  const adopted = await delivery.adopt(generated.asset.id, {
    viewpointName: "1人视.png",
    stage: "stage-3",
    taskId: task.id,
    versionId: "version_00000000-0000-0000-0000-000000000001"
  });
  assert.equal(adopted.filename, "1人视_02.png");
  assert.equal(adopted.usage, "ai-version");
  assert.equal(adopted.deduplicated, false);
  assert.match(await readFile(join(aiRoot, "1人视_提示词.txt"), "utf8"), /保持建筑体块/);

  const duplicate = await delivery.adopt(generated.asset.id, {
    viewpointName: "1人视.png",
    stage: "stage-3",
    taskId: task.id,
    versionId: "version_00000000-0000-0000-0000-000000000001"
  });
  assert.equal(duplicate.filename, "1人视_02.png");
  assert.equal(duplicate.deduplicated, true);

  const localMaterial = await delivery.adopt(generated.asset.id, {
    viewpointName: "1人视",
    stage: "stage-4",
    taskId: task.id
  });
  assert.equal(localMaterial.filename, "1人视_玻璃整图_01.png");
  assert.equal(localMaterial.usage, "ps-glass-full-frame");
  const logLines = (await readFile(join(root, "logs", "formal-adoption.ndjson"), "utf8"))
    .trim()
    .split(/\r?\n/);
  assert.equal(logLines.length, 2);
});

test("正式交接目录必须明确指向 AI，更新配置前保留备份", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-canvas-delivery-config-"));
  const effectsRoot = join(root, "效果图");
  await mkdir(effectsRoot, { recursive: true });
  const assets = new CanvasAssetRepository(root); await assets.init();
  const store = new TaskStore(root); await store.init();
  const delivery = new DeliveryRepository(root, assets, store); await delivery.init();

  await assert.rejects(() => delivery.saveTarget(effectsRoot), /以 AI 目录结尾/);
  await delivery.saveTarget(join(effectsRoot, "AI"));
  await delivery.saveTarget(join(effectsRoot, "AI"));
  const backups = await readdir(join(root, "backups", "delivery-target"));
  assert.equal(backups.length, 1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { TextDecoder, TextEncoder } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("历史图片基线只保存哈希并过滤重复源地址", async () => {
  const source = await readFile(resolve(root, "dist", "content", "page-state.js"), "utf8");
  const context: Record<string, unknown> = {
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    AbortController,
    Uint8Array,
    URL,
    location: { href: "https://chatgpt.com/" },
    setTimeout,
    clearTimeout
  };
  vm.createContext(context); vm.runInContext(source, context);
  const api = context.GPTCanvasContent as {
    digestSource(value: string): Promise<string>;
    filterNewSources(values: string[], baseline: Set<string>): Promise<string[]>;
    parseSrcset(value: string): string[];
    isCollectableGeneratedImage(source: string, width: number, height: number, explicitlyGenerated?: boolean): boolean;
    detectSupportedImageMime(bytes: Uint8Array, declaredMime?: string): string | null;
    isAssistantConversationTurn(authorRoles: string[]): boolean;
    isFlowWorkspaceLaunchLabel(value: string): boolean;
    reusableFlowFilename(sha256: string, mime: string): string;
    hasCompletePrompt(expected: string, received: string): boolean;
    shouldAutoFill(status: string): boolean;
    activationMode(status: string, submittedAt?: string): "fill" | "observe" | "manual";
    preferredResponseKind(mode: "image" | "text" | "image-or-text", imageCount: number, textLength: number): "image" | "text" | null;
    containsSandboxImagePath(value: string): boolean;
  };
  const oldUrl = "https://files.example/old.png"; const newUrl = "https://files.example/new.png";
  const oldHash = await api.digestSource(oldUrl);
  assert.match(oldHash, /^[a-f0-9]{64}$/); assert.doesNotMatch(oldHash, /files\.example/);
  assert.deepEqual(Array.from(await api.filterNewSources([oldUrl, oldUrl, newUrl], new Set([oldHash]))), [newUrl]);
  assert.deepEqual(Array.from(api.parseSrcset("a.png 1x, b.png 2x")), ["a.png", "b.png"]);
  assert.equal(api.isCollectableGeneratedImage("https://files.example/result.png", 1024, 768), true);
  assert.equal(api.isCollectableGeneratedImage("https://chatgpt.com/backend-api/estuary/content?id=result", 0, 0, true), true);
  assert.equal(api.isCollectableGeneratedImage("https://chatgpt.com/backend-api/estuary/content?id=result", 0, 0), false);
  assert.equal(api.isCollectableGeneratedImage("chrome-extension://example/icon.svg", 1024, 768), false);
  assert.equal(api.isCollectableGeneratedImage("https://files.example/icon.svg", 150, 150), false);
  assert.equal(api.detectSupportedImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "application/octet-stream"), "image/png");
  assert.equal(api.detectSupportedImageMime(new Uint8Array([0xff, 0xd8, 0xff]), "application/octet-stream"), "image/jpeg");
  assert.equal(api.detectSupportedImageMime(new Uint8Array([0x3c, 0x73, 0x76, 0x67]), "image/svg+xml"), null);
  assert.equal(api.isAssistantConversationTurn(["user"]), false);
  assert.equal(api.isAssistantConversationTurn([]), true);
  assert.equal(api.isAssistantConversationTurn(["assistant"]), true);
  assert.equal(api.isFlowWorkspaceLaunchLabel("Create with Google Flow"), true);
  assert.equal(api.isFlowWorkspaceLaunchLabel("Try Google Flow"), true);
  assert.equal(api.isFlowWorkspaceLaunchLabel("Try in Google Flow"), false);
  assert.equal(api.reusableFlowFilename("ABCDEF0123456789ffff", "image/png"), "canvas_abcdef0123456789.png");
  assert.equal(api.hasCompletePrompt("材质、光影\n输出要求", "材质、光影  输出要求"), true);
  assert.equal(api.hasCompletePrompt("材质、光影\n输出要求", "\uFEFF材质、\u200B光影\n\u2060输出要求\uFEFF"), true);
  assert.equal(api.hasCompletePrompt("材质、光影\n输出要求", "材质、光影"), false);
  assert.equal(api.shouldAutoFill("opening-chat"), true);
  assert.equal(api.shouldAutoFill("ready-to-submit"), true);
  assert.equal(api.shouldAutoFill("submitted"), false);
  assert.equal(api.activationMode("needs-user"), "manual");
  assert.equal(api.activationMode("needs-user", "2026-07-23T00:00:00.000Z"), "observe");
  assert.equal(api.activationMode("opening-chat"), "fill");
  assert.equal(api.activationMode("collecting"), "observe");
  assert.equal(api.preferredResponseKind("image", 0, 80), null);
  assert.equal(api.preferredResponseKind("text", 0, 80), "text");
  assert.equal(api.preferredResponseKind("image-or-text", 1, 80), "image");
  assert.equal(api.preferredResponseKind("image-or-text", 0, 80), "text");
  assert.equal(api.containsSandboxImagePath("/mnt/data/d5_style_target_reference_v2.png"), true);
  assert.equal(api.containsSandboxImagePath("已生成：`/mnt/data/result.webp`"), true);
  assert.equal(api.containsSandboxImagePath("https://example.com/result.png"), false);
});

test("文字任务等待回复完成且必需章节齐全后才允许回收", async () => {
  const source = await readFile(resolve(root, "dist", "content", "page-state.js"), "utf8");
  const context: Record<string, unknown> = {
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    AbortController,
    Uint8Array,
    URL,
    location: { href: "https://chatgpt.com/" },
    setTimeout,
    clearTimeout
  };
  vm.createContext(context); vm.runInContext(source, context);
  const api = context.GPTCanvasContent as {
    textResponseReady(prompt: string, response: string, generating: boolean, completionSignal: boolean): boolean;
  };
  const prompt = "请输出【D5调整建议】【最终生成提示词】【必须保持与禁止改变】";
  const historicalPartial = "ChatGPT 说：【D5调整建议】\n\n光影改为参考图的";
  const complete = "【D5调整建议】\n调整光影。\n【最终生成提示词】\n保持结构。\n【必须保持与禁止改变】\n不得改建筑。";
  const markdownHeadings = "### D5调整建议\n调整光影。\n### 最终生成提示词\n保持结构。\n### 必须保持与禁止改变\n不得改建筑。";
  assert.equal(api.textResponseReady(prompt, historicalPartial, false, true), false);
  assert.equal(api.textResponseReady(prompt, complete, true, true), false);
  assert.equal(api.textResponseReady(prompt, complete, false, false), false);
  assert.equal(api.textResponseReady(prompt, complete, false, true), true);
  assert.equal(api.textResponseReady(prompt, markdownHeadings, false, true), true);
});

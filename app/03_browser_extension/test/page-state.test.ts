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
  const context: Record<string, unknown> = { crypto: webcrypto, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout };
  vm.createContext(context); vm.runInContext(source, context);
  const api = context.GPTCanvasContent as {
    digestSource(value: string): Promise<string>;
    filterNewSources(values: string[], baseline: Set<string>): Promise<string[]>;
    parseSrcset(value: string): string[];
    isAssistantConversationTurn(authorRoles: string[]): boolean;
    shouldAutoFill(status: string): boolean;
    activationMode(status: string, submittedAt?: string): "fill" | "observe" | "manual";
  };
  const oldUrl = "https://files.example/old.png"; const newUrl = "https://files.example/new.png";
  const oldHash = await api.digestSource(oldUrl);
  assert.match(oldHash, /^[a-f0-9]{64}$/); assert.doesNotMatch(oldHash, /files\.example/);
  assert.deepEqual(Array.from(await api.filterNewSources([oldUrl, oldUrl, newUrl], new Set([oldHash]))), [newUrl]);
  assert.deepEqual(Array.from(api.parseSrcset("a.png 1x, b.png 2x")), ["a.png", "b.png"]);
  assert.equal(api.isAssistantConversationTurn(["user"]), false);
  assert.equal(api.isAssistantConversationTurn([]), true);
  assert.equal(api.isAssistantConversationTurn(["assistant"]), true);
  assert.equal(api.shouldAutoFill("opening-chat"), true);
  assert.equal(api.shouldAutoFill("ready-to-submit"), true);
  assert.equal(api.shouldAutoFill("submitted"), false);
  assert.equal(api.activationMode("needs-user"), "manual");
  assert.equal(api.activationMode("needs-user", "2026-07-23T00:00:00.000Z"), "observe");
  assert.equal(api.activationMode("opening-chat"), "fill");
  assert.equal(api.activationMode("collecting"), "observe");
});

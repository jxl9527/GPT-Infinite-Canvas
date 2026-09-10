import assert from "node:assert/strict";
import test from "node:test";
import {
  generationTargetForCustomGpt,
  normalizeCustomGptUrl,
  resolveFixedCustomGptUrl
} from "../src/custom-gpt.js";

test("专属 GPT 地址规范化到 GPT 首页而不是具体对话", () => {
  assert.equal(
    normalizeCustomGptUrl("https://chatgpt.com/g/g-example-architect/c/conversation?x=1"),
    "https://chatgpt.com/g/g-example-architect"
  );
  assert.equal(normalizeCustomGptUrl("https://chatgpt.com/"), null);
  assert.equal(normalizeCustomGptUrl("https://example.com/g/g-example"), null);
});

test("未配置时进入普通新对话，配置后定向专属 GPT", () => {
  assert.deepEqual(generationTargetForCustomGpt(""), { provider: "chatgpt", chatMode: "new" });
  assert.deepEqual(generationTargetForCustomGpt("https://chatgpt.com/g/g-example-architect"), {
    provider: "chatgpt",
    chatMode: "existing",
    chatUrl: "https://chatgpt.com/g/g-example-architect"
  });
});

test("固定目标优先跨项目复用，首次配置则继承项目地址", () => {
  assert.equal(
    resolveFixedCustomGptUrl(
      "https://chatgpt.com/g/g-fixed-architect",
      "https://chatgpt.com/g/g-project-specific"
    ),
    "https://chatgpt.com/g/g-fixed-architect"
  );
  assert.equal(
    resolveFixedCustomGptUrl(null, "https://chatgpt.com/g/g-project-specific/c/old-chat"),
    "https://chatgpt.com/g/g-project-specific"
  );
});

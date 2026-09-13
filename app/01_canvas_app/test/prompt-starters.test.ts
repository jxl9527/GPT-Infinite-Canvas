import test from "node:test";
import assert from "node:assert/strict";
import { STARTER_PROMPTS } from "../src/prompt-starters.js";

test("内置图库首批五张效果模板为自包含完整提示词", () => {
  assert.equal(STARTER_PROMPTS.length, 8);
  assert.deepEqual(STARTER_PROMPTS.map((card) => card.id), ["starter-0", "starter-1", "starter-2", "starter-3", "starter-4", "starter-5", "starter-6", "starter-7"]);
  const first = STARTER_PROMPTS.slice(0, 5);
  assert.deepEqual(first.map((card) => card.title), ["明亮晴空 · 清透写实", "D5 质感强化", "玻璃质感优化", "阴天柔光", "蓝调夜景"]);
  for (const card of first) {
    assert.equal(card.category, "效果渲染");
    for (const label of ["REFERENCE｜", "CHANGE ONLY｜", "VISUAL TARGET｜", "CONSTRAINTS｜"]) assert.ok(card.content.includes(label), `${card.title} 缺少 ${label}`);
    assert.ok(!/STYLE-\d|项目知识库|按项目模板执行/.test(card.content), `${card.title} 不能依赖项目知识库`);
  }
  assert.ok(first[0]!.content.includes("PRESERVE EXACTLY｜") && first[0]!.content.includes("相机位置、透视、构图、画幅与宽高比"));
  assert.ok(first[2]!.content.includes("只改玻璃") && first[2]!.content.includes("不得改变天气、时间、材质分区、景观和相机"));
  assert.ok(first[4]!.content.includes("蓝调时刻"));
});

test("图库模板标题与提示词长度满足导入与卡片约束", () => {
  for (const card of STARTER_PROMPTS) {
    assert.ok(card.title.length > 0 && card.title.length <= 40, card.title);
    assert.ok(card.content.trim().length > 0 && card.content.length <= 20_000, card.title);
  }
});

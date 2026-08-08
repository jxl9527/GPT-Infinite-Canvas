import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("可加载产物使用 P1 端口、共享协议副本和经典内容脚本", async () => {
  const manifest = JSON.parse(await readFile(resolve(root, "dist", "manifest.json"), "utf8")) as {
    version: string; host_permissions: string[]; content_scripts: Array<{ js: string[] }>;
  };
  assert.equal(manifest.version, "1.5.20");
  assert.ok((manifest as { permissions?: string[] }).permissions?.includes("debugger"));
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1:3220/*"));
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1:3230/*"));
  assert.ok(manifest.host_permissions.includes("https://labs.google/*"));
  assert.deepEqual(manifest.content_scripts[0]?.js, [
    "content/page-state.js",
    "content/chatgpt-adapter.js",
    "content/flow-adapter.js",
    "content/content.js"
  ]);
  assert.deepEqual(manifest.content_scripts[1]?.js, ["content/canvas-trigger.js"]);

  const protocol = await readFile(resolve(root, "dist", "protocol.js"), "utf8");
  assert.match(protocol, /GENERATION_STATUSES/); assert.doesNotMatch(protocol, /@gpt-canvas\//);
  for (const name of ["page-state.js", "chatgpt-adapter.js", "flow-adapter.js", "content.js", "canvas-trigger.js"]) {
    const source = await readFile(resolve(root, "dist", "content", name), "utf8");
    assert.doesNotMatch(source, /^\s*(?:import|export)\b/m);
  }
});

test("提交实现先锁定服务端 submitted，再点击网页按钮", async () => {
  const source = await readFile(resolve(root, "dist", "content", "content.js"), "utf8");
  const committed = source.indexOf('await send("submitted"');
  const clicked = source.indexOf("button.click()", committed);
  assert.ok(committed >= 0); assert.ok(clicked > committed);
  assert.match(source, /p1-baseline:/);
  assert.match(source, /taskId: bridge\.task\.id/);
  assert.match(source, /observeAndCollect/);
  assert.doesNotMatch(source, /window\.confirm/);
  assert.match(source, /画布一键生成已授权自动提交/);
  assert.match(source, /10 \* 60_000/);
  assert.match(source, /activationMode/);
  const mounted = source.indexOf("mountPanel();");
  const stateRequested = source.indexOf('type: "adapter-get-state"');
  assert.ok(mounted >= 0 && stateRequested > mounted);
  assert.match(source, /当前标签页未绑定任务/);
  assert.match(source, /adapter-bind-current/);
  assert.match(source, /重新绑定当前任务/);
  assert.match(source, /bindingId: bridge\.bindingId/);
  assert.match(source, /自动桥接初始化失败/);
  const composerStart = source.indexOf("function setComposerText");
  const composerEnd = source.indexOf("async function fetchAttachment", composerStart);
  const composerImplementation = source.slice(composerStart, composerEnd);
  assert.match(composerImplementation, /adapter-insert-flow-prompt/);
  assert.match(composerImplementation, /document\.execCommand\("insertText"/);
  assert.doesNotMatch(composerImplementation, /target\.textContent = text/);
  assert.match(composerImplementation, /hasCompletePrompt\(text, received\)/);
  assert.match(composerImplementation, /data-slate-placeholder='true'/);
  assert.match(composerImplementation, /clone\.textContent/);
  assert.doesNotMatch(composerImplementation, /requestAnimationFrame/);
  assert.match(composerImplementation, /提示词完整性校验失败/);
  assert.match(source, /adapter\.isSendReady\(\)/);
  assert.match(source, /waitForAttachmentCount\(0, 1_000\)/);
  assert.match(source, /waitForAttachmentCount\(index \+ 1\)/);
  assert.match(source, /submissionMarker = adapter\.submissionMarker/);
  assert.match(source, /waitForSubmissionStart\(submissionMarker\)/);
  assert.match(source, /提示词与 \$\{bridge\.task\.attachments\.length\} 张附件已在可见页面确认/);
  const flowAdapter = await readFile(resolve(root, "dist", "content", "flow-adapter.js"), "utf8");
  assert.match(flowAdapter, /selectOutputCount/);
  assert.match(flowAdapter, /Google Flow 未确认 x/);
  assert.match(flowAdapter, /await this\.waitForComposer\(\)/);
  assert.match(flowAdapter, /settingsOpened/);
  assert.match(flowAdapter, /add_2/);
  assert.match(flowAdapter, /assetDeadline/);
  assert.match(flowAdapter, /\[role='dialog'\]/);
  assert.match(flowAdapter, /账号侧检测到异常活动/);
  assert.match(flowAdapter, /deepQueryAll/);
  assert.match(flowAdapter, /shadowRoot/);
  assert.match(flowAdapter, /mappedProjectMissing/);
  assert.match(flowAdapter, /chrome\.storage\.local\.remove\(\[bindingKey, pendingKey\]\)/);
  assert.match(flowAdapter, /missingProjectPage/);
  assert.match(flowAdapter, /出了点问题/);
  assert.match(flowAdapter, /location\.pathname\.includes\(FLOW_PROJECT_PATH\) && this\.composer\(\)/);
  const background = await readFile(resolve(root, "dist", "background.js"), "utf8");
  assert.match(background, /Input\.insertText/);
  assert.match(background, /Input\.dispatchMouseEvent/);
  assert.match(background, /chrome\.debugger\.detach/);
  assert.match(source, /adapter-click-flow-create/);
  assert.match(source, /generationFailureReason/);
  assert.match(source, /collectAssistantText/);
  assert.match(source, /\/text-result/);
  assert.match(source, /responseMode/);
  assert.match(source, /专属 GPT 本轮只返回了文字/);
  assert.match(source, /containsSandboxImagePath/);
  assert.match(source, /内部沙盒路径/);
  assert.match(source, /sandboxPathRecoveryAttempted/);
  assert.match(source, /detectSupportedImageMime/);
  assert.match(source, /prepareManualFlowSubmit/);
  assert.match(source, /用户在 Google Flow 页面亲自点击创建/);
  assert.match(source, /event\.isTrusted/);
  assert.match(source, /adapter-focus-current/);
  const canvasTrigger = await readFile(resolve(root, "dist", "content", "canvas-trigger.js"), "utf8");
  assert.match(canvasTrigger, /gpt-canvas-run-task/);
  assert.match(canvasTrigger, /canvas-task-completed/);
  assert.match(canvasTrigger, /getManifest\(\)\.version/);
  assert.match(canvasTrigger, /data-gpt-canvas-extension-version/);

  const chatgptAdapter = await readFile(resolve(root, "dist", "content", "chatgpt-adapter.js"), "utf8");
  assert.match(chatgptAdapter, /latestTurn = turns\[turns\.length - 1\]/);
  assert.match(chatgptAdapter, /isAssistantConversationTurn\(roles\)/);
  assert.doesNotMatch(chatgptAdapter, /roles\.includes\("assistant"\)/);
  assert.match(chatgptAdapter, /isCollectableGeneratedImage/);
  assert.match(chatgptAdapter, /collectAssistantText/);
  assert.match(chatgptAdapter, /attachmentRemove/);
  assert.match(chatgptAdapter, /ChatGPT 附件确认超时/);
  assert.match(chatgptAdapter, /ChatGPT 未确认发送/);
  assert.match(chatgptAdapter, /submissionMarker\(\)/);
  assert.match(chatgptAdapter, /45_000/);
  assert.match(chatgptAdapter, /未出现新对话轮次/);
  assert.doesNotMatch(chatgptAdapter, /reverse\(\)\.find/);
});

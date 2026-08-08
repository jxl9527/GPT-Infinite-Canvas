interface BridgeAttachment { id: string; name: string; mime: string; sha256: string }
interface BridgeEvent { status: string }
interface BridgeTask {
  id: string;
  status: string;
  submittedAt?: string;
  responseMode?: "image" | "text" | "image-or-text";
  target: {
    provider?: "chatgpt" | "google-flow";
    localProject?: { id: string; name: string };
    outputCount?: 1 | 2 | 3 | 4;
  };
  prompt: string;
  attachments: BridgeAttachment[];
  events: BridgeEvent[];
}
interface BridgeState { task: BridgeTask; apiRoot: string; token: string; bindingId: string }
interface ExtensionResponse { ok: boolean; error?: string; task?: BridgeTask | null; apiRoot?: string; token?: string; bindingId?: string }

let bridge: BridgeState | null = null;
let panel: HTMLElement | null = null;
let baselineHashes = new Set<string>();
let submitted = false;
let submitting = false;
let filling = false;
let observing = false;
let filledOnThisPage = false;
let manualFlowReady = false;
let sandboxPathRecoveryAttempted = false;
let sandboxPathRecoveryStartedAt = 0;
const SANDBOX_PATH_RECOVERY_PROMPT = `你刚才只返回了内部沙盒图片路径，画布无法访问该路径。请立即改用 ChatGPT 的图片生成能力，把生成结果作为本轮回复中的可见图片直接显示。不得使用 Python、PIL、代码解释器或数据分析工具生成／另存文件，不得只回复 /mnt/data 路径、文件名或下载说明；保持上一轮全部结构保护、构图和风格要求不变。`;
const adapter: GPTCanvasContent.GenerationPageAdapter = location.hostname === "labs.google"
  ? new GPTCanvasContent.FlowAdapter(document)
  : new GPTCanvasContent.ChatGptAdapter(document);

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "发生未知错误"; }
function baselineKey(): string { return bridge ? `p1-baseline:${bridge.task.id}` : ""; }
function responseMode(): "image" | "text" | "image-or-text" { return bridge?.task.responseMode ?? "image"; }

async function send(event: string, payload: Record<string, unknown> = {}): Promise<ExtensionResponse> {
  if (!bridge) throw new Error("任务尚未绑定到当前页面");
  const response = await chrome.runtime.sendMessage({ type: "adapter-event", taskId: bridge.task.id, bindingId: bridge.bindingId, event, ...payload }) as ExtensionResponse;
  if (!response.ok) throw new Error(response.error ?? "扩展后台拒绝页面操作");
  if (response.task) bridge.task = response.task;
  return response;
}

function setStatus(text: string, tone = ""): void {
  const target = panel?.querySelector<HTMLElement>("[data-role=status]");
  if (target) { target.textContent = text; target.dataset.tone = tone; }
}

function mountPanel(): void {
  if (panel) return;
  panel = document.createElement("aside"); panel.id = "gpt-canvas-p1-panel";
  panel.innerHTML = `<style>
    #gpt-canvas-p1-panel{position:fixed;right:18px;bottom:18px;z-index:2147483647;width:292px;padding:15px;background:#27231f;color:#f8f3e9;box-shadow:0 12px 34px rgba(30,23,18,.28);font:12px/1.5 "Microsoft YaHei UI",sans-serif}
    #gpt-canvas-p1-panel p{margin:0 0 7px;color:#cdbfaf;font-size:10px;letter-spacing:.12em}#gpt-canvas-p1-panel strong{display:block;margin-bottom:9px;font:600 14px "Songti SC",serif;word-break:break-all}
    #gpt-canvas-p1-panel button{border:1px solid #88796b;background:transparent;color:#f8f3e9;padding:7px 8px;margin:3px 3px 0 0;cursor:pointer;font:inherit}#gpt-canvas-p1-panel button[data-main]{background:#a44a32;border-color:#a44a32}#gpt-canvas-p1-panel button:disabled{opacity:.45;cursor:not-allowed}
    #gpt-canvas-p1-panel [data-role=status]{display:block;margin-top:10px;color:#dfcdbb}#gpt-canvas-p1-panel [data-tone=error]{color:#ffb39f}
  </style><p>GPT CANVAS · <span data-role="provider"></span></p><strong></strong><button data-action="bind">重新绑定当前任务</button><button data-action="fill">重新填入附件</button><button data-action="submit" data-main>重新触发自动提交</button><button data-action="collect">立即检查结果</button><button data-action="handoff">转人工接管</button><span data-role="status">等待全自动任务绑定</span>`;
  document.documentElement.append(panel);
  const provider = panel.querySelector<HTMLElement>("[data-role=provider]");
  if (provider) provider.textContent = `${adapter.label.toUpperCase()} · v${chrome.runtime.getManifest().version}`;
  const submitAction = panel.querySelector<HTMLButtonElement>("[data-action=submit]");
  if (submitAction && adapter.provider === "google-flow") submitAction.textContent = "准备人工提交";
  panel.querySelector<HTMLButtonElement>("[data-action=bind]")?.addEventListener("click", () => void bindCurrentPage());
  panel.querySelector<HTMLButtonElement>("[data-action=fill]")?.addEventListener("click", () => void fillAndUpload());
  panel.querySelector<HTMLButtonElement>("[data-action=submit]")?.addEventListener("click", () => {
    if (adapter.provider === "google-flow") void prepareManualFlowSubmit();
    else void submitOnce();
  });
  panel.querySelector<HTMLButtonElement>("[data-action=collect]")?.addEventListener("click", () => void collectCurrentResponse());
  panel.querySelector<HTMLButtonElement>("[data-action=handoff]")?.addEventListener("click", () => void handoff("用户要求人工接管"));
}

async function bindCurrentPage(): Promise<void> {
  try {
    setStatus(`正在校验并绑定当前 ${adapter.label} 标签页…`);
    const response = await chrome.runtime.sendMessage({ type: "adapter-bind-current" }) as ExtensionResponse;
    if (!response.ok || !response.task || !response.apiRoot || !response.token || !response.bindingId) throw new Error(response.error ?? "后台没有返回可绑定任务");
    await activate({ task: response.task, apiRoot: response.apiRoot, token: response.token, bindingId: response.bindingId });
  } catch (error) { setStatus(`绑定失败：${errorMessage(error)}`, "error"); }
}

async function autoBindCurrentPage(): Promise<boolean> {
  const response = await chrome.runtime.sendMessage({ type: "adapter-auto-bind-current" }) as ExtensionResponse;
  if (!response.ok || !response.task || !response.apiRoot || !response.token || !response.bindingId) return false;
  await activate({ task: response.task, apiRoot: response.apiRoot, token: response.token, bindingId: response.bindingId });
  return true;
}

async function setComposerText(target: HTMLElement, text: string): Promise<void> {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(target, text);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (adapter.provider === "google-flow") {
    if (!bridge) throw new Error("任务状态缺失");
    target.focus();
    const response = await chrome.runtime.sendMessage({
      type: "adapter-insert-flow-prompt",
      taskId: bridge.task.id,
      bindingId: bridge.bindingId,
      text
    }) as ExtensionResponse;
    if (!response.ok) throw new Error(response.error ?? "Google Flow 可信文本输入失败");
  } else {
    target.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const inserted = document.execCommand("insertText", false, text);
    selection?.removeAllRanges();
    if (!inserted) throw new Error("Google Flow 编辑器拒绝原生文本输入；请刷新页面后重试");
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  const received = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement
    ? target.value
    : (() => {
        const clone = target.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("[data-slate-placeholder='true']").forEach((placeholder) => placeholder.remove());
        return clone.textContent || "";
      })();
  if (!GPTCanvasContent.hasCompletePrompt(text, received)) {
    throw new Error(`提示词完整性校验失败：任务 ${text.length} 字，Flow 页面接收 ${received.length} 字`);
  }
}

async function fetchAttachment(attachment: BridgeAttachment, filename = attachment.name): Promise<File> {
  if (!bridge) throw new Error("任务状态缺失");
  const response = await GPTCanvasContent.fetchWithTimeout(
    `${bridge.apiRoot}/api/v1/tasks/${encodeURIComponent(bridge.task.id)}/attachments/${encodeURIComponent(attachment.id)}`,
    { headers: { "x-bridge-token": bridge.token } },
    30_000
  );
  if (!response.ok) throw new Error(`附件读取失败：HTTP ${response.status}`);
  const blob = await response.blob(); return new File([blob], filename, { type: blob.type || attachment.mime });
}

async function fillAndUpload(): Promise<void> {
  if (!bridge || filling || submitted || filledOnThisPage) return;
  filling = true;
  try {
    setStatus(`正在准备 ${adapter.label} 图片生成页…`);
    await adapter.preparePage({
      ...(bridge.task.target.localProject ? { localProject: bridge.task.target.localProject } : {}),
      ...(bridge.task.target.outputCount ? { outputCount: bridge.task.target.outputCount } : {})
    });
    setStatus(`正在等待 ${adapter.label} 输入区；如未登录请完成登录…`);
    const target = await adapter.waitForComposer();
    if (adapter.provider === "chatgpt") {
      if (!adapter.waitForAttachmentCount) throw new Error("当前 ChatGPT 适配器缺少附件数量校验");
      await adapter.waitForAttachmentCount(0, 1_000);
    }
    filledOnThisPage = true;
    setStatus("正在填入提示词并逐字校验…"); await setComposerText(target, bridge.task.prompt);
    if (bridge.task.attachments.length) {
      await send("upload-started", { note: "画布一键任务自动上传附件" });
      if (adapter.provider === "google-flow") {
        for (const attachment of bridge.task.attachments) {
          const remoteName = GPTCanvasContent.reusableFlowFilename(attachment.sha256, attachment.mime);
          if (adapter.tryReuseAttachment && await adapter.tryReuseAttachment(remoteName)) continue;
          const input = await adapter.waitForUploadInput();
          const transfer = new DataTransfer();
          transfer.items.add(await fetchAttachment(attachment, remoteName));
          input.files = transfer.files;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          if (!adapter.tryReuseAttachment || !await adapter.tryReuseAttachment(remoteName)) {
            throw new Error(`Google Flow 已上传 ${remoteName}，但未能将它添加到提示`);
          }
        }
      } else {
        if (!adapter.waitForAttachmentCount) throw new Error("当前 ChatGPT 适配器缺少附件数量校验");
        for (const [index, attachment] of bridge.task.attachments.entries()) {
          const input = await adapter.waitForUploadInput();
          const transfer = new DataTransfer();
          transfer.items.add(await fetchAttachment(attachment));
          input.files = transfer.files;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          await adapter.waitForAttachmentCount(index + 1);
        }
      }
    }
    await adapter.waitUntilSendReady();
    await send("ready-to-submit", { note: `提示词与 ${bridge.task.attachments.length} 张附件已在可见页面确认` });
    if (adapter.provider === "google-flow") {
      await prepareManualFlowSubmit();
    } else {
      setStatus("附件和提示词已就绪，正在自动提交…");
      await submitOnce();
    }
  } catch (error) { filledOnThisPage = false; await handoff(errorMessage(error)); }
  finally { filling = false; }
}

function waitForResultSignal(timeoutMs = 2_000): Promise<void> {
  const resultSelector = "img[src], button[data-testid='stop-button'], button[aria-label*='Stop'], button[aria-label*='停止']";
  const containsResultSignal = (node: Node): boolean => node instanceof Element
    && (node.matches(resultSelector) || Boolean(node.querySelector(resultSelector)));
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    };
    const observer = new MutationObserver((records) => {
      if (records.some((record) => record.type === "attributes"
        || [...record.addedNodes, ...record.removedNodes].some(containsResultSignal))) finish();
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["src"]
    });
    const timer = setTimeout(finish, timeoutMs);
  });
}

async function prepareManualFlowSubmit(): Promise<void> {
  if (!bridge || adapter.provider !== "google-flow" || submitted || submitting) return;
  if (!adapter.isSendReady()) {
    setStatus("Flow 创建按钮尚未就绪，请确认提示词、附件和输出数量。", "error");
    return;
  }
  baselineHashes = new Set(await GPTCanvasContent.digestSources(adapter.collectGeneratedImages()));
  await chrome.storage.local.set({ [baselineKey()]: [...baselineHashes] });
  manualFlowReady = true;
  setStatus("已准备完毕：请在 Flow 页面亲自点击一次“创建”；随后将自动收图回画布。");
  const response = await chrome.runtime.sendMessage({
    type: "adapter-focus-current",
    taskId: bridge.task.id,
    bindingId: bridge.bindingId
  }) as ExtensionResponse;
  if (!response.ok) throw new Error(response.error ?? "无法切换到 Flow 标签页");
}

async function recordManualFlowSubmit(): Promise<void> {
  if (!bridge || !manualFlowReady || submitted || submitting) return;
  submitting = true;
  manualFlowReady = false;
  try {
    await send("submitted", { note: "用户在 Google Flow 页面亲自点击创建；扩展仅记录并等待结果" });
    submitted = true;
    panel?.querySelector<HTMLButtonElement>("[data-action=submit]")?.setAttribute("disabled", "true");
    await new Promise((resolve) => setTimeout(resolve, 750));
    await send("generating", { note: "等待用户手动提交的 Flow 结果" });
    setStatus("已检测到人工创建；生成完成后将自动收集并返回画布。");
    void observeAndCollect();
  } catch (error) {
    await handoff(`人工创建记账失败：${errorMessage(error)}`);
  } finally {
    submitting = false;
  }
}

async function submitOnce(): Promise<void> {
  if (!bridge || submitted || submitting) { setStatus("本轮已经提交或正在提交，系统不会再次提交。", "error"); return; }
  const button = adapter.sendButton();
  if (!button || !adapter.isSendReady()) { setStatus("提交按钮未就绪，请确认提示词与附件已被网页识别。", "error"); return; }
  submitting = true;
  try {
    baselineHashes = new Set(await GPTCanvasContent.digestSources(adapter.collectGeneratedImages()));
    await chrome.storage.local.set({ [baselineKey()]: [...baselineHashes] });
    await send("submitted", { note: "画布一键生成已授权自动提交；服务已先锁定单次提交" });
    submitted = true;
    panel?.querySelector<HTMLButtonElement>("[data-action=submit]")?.setAttribute("disabled", "true");
    if (adapter.provider === "google-flow") {
      const rect = button.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) throw new Error("Google Flow 创建按钮不在可点击区域");
      const response = await chrome.runtime.sendMessage({
        type: "adapter-click-flow-create",
        taskId: bridge.task.id,
        bindingId: bridge.bindingId,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      }) as ExtensionResponse;
      if (!response.ok) throw new Error(response.error ?? "Google Flow 可信创建点击失败");
    } else {
      const submissionMarker = adapter.submissionMarker?.();
      button.click();
      if (!adapter.waitForSubmissionStart) throw new Error("当前 ChatGPT 适配器缺少发送结果校验");
      await adapter.waitForSubmissionStart(submissionMarker);
    }
    await send("generating", { note: "等待当前回复完成" });
    setStatus("已自动单次提交；生成完成后将自动收集并返回画布。");
    void observeAndCollect();
  } catch (error) {
    if (bridge?.task.submittedAt || submitted) await handoff(`提交记账后网页操作异常：${errorMessage(error)}`);
    else setStatus(errorMessage(error), "error");
  } finally { submitting = false; }
}

async function saveResult(source: string): Promise<void> {
  if (!bridge) throw new Error("任务状态缺失");
  const response = await GPTCanvasContent.fetchWithTimeout(source, { credentials: "include" }, 180_000);
  if (!response.ok) throw new Error(`结果图片下载失败：HTTP ${response.status}`);
  const responseBlob = await response.blob();
  const bytes = new Uint8Array(await responseBlob.arrayBuffer());
  const mimeType = GPTCanvasContent.detectSupportedImageMime(bytes, responseBlob.type);
  if (!mimeType) throw new Error("结果内容不是受支持的 PNG、JPEG 或 WebP 图片");
  const bitmap = new Blob([bytes], { type: mimeType });
  const dataUrl = await GPTCanvasContent.blobToDataUrl(bitmap);
  const stored = await GPTCanvasContent.fetchWithTimeout(
    `${bridge.apiRoot}/api/v1/tasks/${encodeURIComponent(bridge.task.id)}/results`,
    { method: "POST", headers: { "content-type": "application/json", "x-bridge-token": bridge.token }, body: JSON.stringify({ dataUrl }) },
    60_000
  );
  if (!stored.ok) {
    const failure = await stored.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(failure?.error?.message ?? "本地结果写入失败");
  }
}

async function collectResults(): Promise<void> {
  if (!bridge || !submitted) { setStatus("请先完成本轮单次提交。", "error"); return; }
  const collectButton = panel?.querySelector<HTMLButtonElement>("[data-action=collect]");
  if (collectButton?.disabled) { setStatus("本轮结果正在收集，请勿重复点击。", "error"); return; }
  const sources = await GPTCanvasContent.filterNewSources(adapter.collectGeneratedImages(), baselineHashes);
  if (!sources.length) { setStatus("未识别到本轮新增图片，请等待生成完成或转人工接管。", "error"); return; }
  if (collectButton) collectButton.disabled = true;
  try {
    await send("collecting", { note: `识别到 ${sources.length} 张本轮新增图片` });
    setStatus(`正在保存 ${sources.length} 张图片；大图可能需要约 3 分钟…`);
    await Promise.all(sources.map(saveResult));
    await send("completed"); await chrome.storage.local.remove(baselineKey());
    setStatus(`${sources.length} 张本轮图片已保存到本地任务目录。`);
  } catch (error) {
    if (collectButton) collectButton.disabled = false;
    await handoff(`结果收集失败：${errorMessage(error)}`);
  }
}

async function collectTextResult(): Promise<void> {
  if (!bridge || !submitted) { setStatus("请先完成本轮单次提交。", "error"); return; }
  const text = adapter.collectAssistantText?.().trim() ?? "";
  if (text.length < 2) { setStatus("未识别到本轮文字结论，请等待回复完成或转人工接管。", "error"); return; }
  const collectButton = panel?.querySelector<HTMLButtonElement>("[data-action=collect]");
  if (collectButton?.disabled) { setStatus("本轮结果正在收集，请勿重复点击。", "error"); return; }
  if (collectButton) collectButton.disabled = true;
  try {
    await send("collecting", { note: `识别到 ${text.length} 字本轮文字结论` });
    const stored = await GPTCanvasContent.fetchWithTimeout(
      `${bridge.apiRoot}/api/v1/tasks/${encodeURIComponent(bridge.task.id)}/text-result`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-bridge-token": bridge.token },
        body: JSON.stringify({ text })
      },
      30_000
    );
    if (!stored.ok) {
      const failure = await stored.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(failure?.error?.message ?? "本地文字结果写入失败");
    }
    await send("completed"); await chrome.storage.local.remove(baselineKey());
    setStatus("本轮文字结论已保存，并将回写到画布视角状态卡。");
  } catch (error) {
    if (collectButton) collectButton.disabled = false;
    await handoff(`文字结果收集失败：${errorMessage(error)}`);
  }
}

async function collectCurrentResponse(): Promise<void> {
  const mode = responseMode();
  const sources = await GPTCanvasContent.filterNewSources(adapter.collectGeneratedImages(), baselineHashes);
  if (mode !== "text" && sources.length) return collectResults();
  if (mode !== "image" && (adapter.collectAssistantText?.().trim().length ?? 0) >= 2) return collectTextResult();
  setStatus(mode === "image" ? "未识别到本轮新增图片。" : "尚未识别到可回收的本轮结果。", "error");
}

async function recoverSandboxPathResponse(): Promise<boolean> {
  if (!bridge || sandboxPathRecoveryAttempted || adapter.provider !== "chatgpt") return false;
  sandboxPathRecoveryAttempted = true;
  sandboxPathRecoveryStartedAt = Date.now();
  try {
    setStatus("检测到内部沙盒路径，正在自动纠正为可见图片输出…");
    const target = await adapter.waitForComposer();
    await setComposerText(target, SANDBOX_PATH_RECOVERY_PROMPT);
    await adapter.waitUntilSendReady();
    const button = adapter.sendButton();
    if (!button || !adapter.isSendReady()) throw new Error("纠偏消息提交按钮未就绪");
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    setStatus("已自动纠偏一次；正在等待专属 GPT 返回可见图片…");
    return true;
  } catch (error) {
    await handoff(`内部路径自动纠偏失败：${errorMessage(error)}`);
    return false;
  }
}

async function observeAndCollect(): Promise<void> {
  if (!bridge || !submitted || observing || bridge.task.status === "completed") return;
  observing = true;
  const deadline = Date.now() + 10 * 60_000;
  let previous = ""; let stablePolls = 0; let textOnlyStablePolls = 0; let previousText = "";
  try {
    setStatus("正在观察本轮生成状态；完成后将自动收图…");
    while (Date.now() < deadline && bridge && bridge.task.status !== "completed") {
      const failure = adapter.generationFailureReason?.();
      if (failure) { await handoff(failure); return; }
      const sources = await GPTCanvasContent.filterNewSources(adapter.collectGeneratedImages(), baselineHashes);
      const signature = [...sources].sort().join("\n");
      const mode = responseMode();
      const assistantText = adapter.collectAssistantText?.().trim() ?? "";
      if (mode === "image"
        && sandboxPathRecoveryAttempted
        && GPTCanvasContent.containsSandboxImagePath(assistantText)
        && Date.now() - sandboxPathRecoveryStartedAt < 30_000) {
        textOnlyStablePolls = 0;
        previousText = assistantText;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }
      if (mode !== "text" && sources.length && !adapter.isGenerating()) {
        stablePolls = signature === previous ? stablePolls + 1 : 1; previous = signature;
        textOnlyStablePolls = 0;
        if (stablePolls >= 3) { await collectResults(); return; }
      } else {
        stablePolls = 0; previous = signature;
        textOnlyStablePolls = !adapter.isGenerating() && assistantText.length >= 20
          ? assistantText === previousText ? textOnlyStablePolls + 1 : 1
          : 0;
        previousText = assistantText;
        if (textOnlyStablePolls >= 3) {
          if (mode === "text" || mode === "image-or-text") await collectTextResult();
          else if (GPTCanvasContent.containsSandboxImagePath(assistantText) && !sandboxPathRecoveryAttempted) {
            if (await recoverSandboxPathResponse()) {
              textOnlyStablePolls = 0;
              previousText = "";
              await new Promise((resolve) => setTimeout(resolve, 2_000));
              continue;
            }
          } else await handoff(sandboxPathRecoveryAttempted
            ? "专属 GPT 自动纠偏后仍未返回可见图片；请确认该 GPT 已开启图片生成功能"
            : "专属 GPT 本轮只返回了文字，没有生成可回收图片；请检查阶段执行规则或在网页中重试生图");
          return;
        }
      }
      await waitForResultSignal();
    }
    if (bridge?.task.status !== "completed") await handoff("10 分钟内未能稳定识别本轮完成图片");
  } catch (error) { await handoff(`自动观察失败：${errorMessage(error)}`); }
  finally { observing = false; }
}

async function handoff(reason: string): Promise<void> {
  try {
    await send("handoff", { reason, completedSteps: bridge?.task.events.map((item) => item.status) ?? [] });
    setStatus(`已转人工接管：${reason}`, "error");
  } catch (error) { setStatus(`人工接管记录失败：${errorMessage(error)}`, "error"); }
}

async function activate(state: BridgeState): Promise<void> {
  const taskProvider = state.task.target.provider ?? "chatgpt";
  if (taskProvider !== adapter.provider) {
    throw new Error(`任务要求 ${taskProvider === "google-flow" ? "Google Flow" : "ChatGPT"}，当前页面来源不匹配`);
  }
  if (bridge?.task.id !== state.task.id) {
    filledOnThisPage = false;
    sandboxPathRecoveryAttempted = false;
    sandboxPathRecoveryStartedAt = 0;
  }
  bridge = state;
  const mode = GPTCanvasContent.activationMode(state.task.status, state.task.submittedAt);
  submitted = mode === "observe";
  const stored = await chrome.storage.local.get(baselineKey()) as Record<string, unknown>;
  const baseline = stored[baselineKey()]; baselineHashes = new Set(Array.isArray(baseline) ? baseline.filter((value): value is string => typeof value === "string") : []);
  mountPanel(); const title = panel?.querySelector("strong"); if (title) title.textContent = state.task.id;
  const submitButton = panel?.querySelector<HTMLButtonElement>("[data-action=submit]"); if (submitButton) submitButton.disabled = submitted;
  setStatus(submitted ? "已恢复自动任务；生成完成后将自动收集。" : "已绑定全自动任务，正在准备输入区…");
  if (mode === "observe") void observeAndCollect();
  else if (mode === "fill") void fillAndUpload();
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  const value = typeof message === "object" && message !== null ? message as { type?: unknown; task?: BridgeTask; apiRoot?: string; token?: string; bindingId?: string } : {};
  if (value.type === "task-ready" && value.task && value.apiRoot && value.token && value.bindingId) void activate({ task: value.task, apiRoot: value.apiRoot, token: value.token, bindingId: value.bindingId });
});

document.addEventListener("click", (event) => {
  if (!event.isTrusted || !manualFlowReady || adapter.provider !== "google-flow") return;
  const button = adapter.sendButton();
  const target = event.target;
  if (!button || !(target instanceof Node) || (target !== button && !button.contains(target))) return;
  void recordManualFlowSubmit();
}, true);

mountPanel();
setStatus("自动内容脚本已加载，正在绑定当前任务…");

(async () => {
  const response = await chrome.runtime.sendMessage({ type: "adapter-get-state" }) as ExtensionResponse;
  if (!response.ok) { setStatus(`自动桥接后台连接失败：${response.error ?? "未知错误"}`, "error"); return; }
  if (response.task && response.apiRoot && response.token && response.bindingId) {
    await activate({ task: response.task, apiRoot: response.apiRoot, token: response.token, bindingId: response.bindingId }); return;
  }
  if (await autoBindCurrentPage()) return;
  setStatus("自动桥接已加载，但当前标签页未绑定任务；可使用“重新绑定当前任务”兜底。", "error");
})().catch((error: unknown) => setStatus(`自动桥接初始化失败：${errorMessage(error)}`, "error"));

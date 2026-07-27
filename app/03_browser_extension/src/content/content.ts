interface BridgeAttachment { id: string; name: string; mime: string }
interface BridgeEvent { status: string }
interface BridgeTask {
  id: string;
  status: string;
  submittedAt?: string;
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
const adapter = new GPTCanvasContent.ChatGptAdapter(document);

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "发生未知错误"; }
function baselineKey(): string { return bridge ? `p1-baseline:${bridge.task.id}` : ""; }

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
  </style><p>GPT CANVAS · AUTO</p><strong></strong><button data-action="bind">重新绑定当前任务</button><button data-action="fill">重新填入附件</button><button data-action="submit" data-main>重新触发自动提交</button><button data-action="collect">立即检查结果</button><button data-action="handoff">转人工接管</button><span data-role="status">等待全自动任务绑定</span>`;
  document.documentElement.append(panel);
  panel.querySelector<HTMLButtonElement>("[data-action=bind]")?.addEventListener("click", () => void bindCurrentPage());
  panel.querySelector<HTMLButtonElement>("[data-action=fill]")?.addEventListener("click", () => void fillAndUpload());
  panel.querySelector<HTMLButtonElement>("[data-action=submit]")?.addEventListener("click", () => void submitOnce());
  panel.querySelector<HTMLButtonElement>("[data-action=collect]")?.addEventListener("click", () => void collectResults());
  panel.querySelector<HTMLButtonElement>("[data-action=handoff]")?.addEventListener("click", () => void handoff("用户要求人工接管"));
}

async function bindCurrentPage(): Promise<void> {
  try {
    setStatus("正在校验并绑定当前 ChatGPT 标签页…");
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

function setComposerText(target: HTMLElement, text: string): void {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(target, text);
    target.dispatchEvent(new Event("input", { bubbles: true })); return;
  }
  target.focus(); target.textContent = text;
  target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}

async function fetchAttachment(attachment: BridgeAttachment): Promise<File> {
  if (!bridge) throw new Error("任务状态缺失");
  const response = await GPTCanvasContent.fetchWithTimeout(
    `${bridge.apiRoot}/api/v1/tasks/${encodeURIComponent(bridge.task.id)}/attachments/${encodeURIComponent(attachment.id)}`,
    { headers: { "x-bridge-token": bridge.token } },
    30_000
  );
  if (!response.ok) throw new Error(`附件读取失败：HTTP ${response.status}`);
  const blob = await response.blob(); return new File([blob], attachment.name, { type: blob.type || attachment.mime });
}

async function fillAndUpload(): Promise<void> {
  if (!bridge || filling || submitted || filledOnThisPage) return;
  filling = true;
  try {
    setStatus("正在等待 ChatGPT 输入区；如未登录请完成登录…");
    const target = await adapter.waitForComposer();
    filledOnThisPage = true;
    setStatus("正在填入提示词…"); setComposerText(target, bridge.task.prompt);
    if (bridge.task.attachments.length) {
      await send("upload-started", { note: "画布一键任务自动上传附件" });
      const input = adapter.uploadInput(); if (!input) throw new Error("未找到网页附件输入控件");
      const transfer = new DataTransfer();
      for (const attachment of bridge.task.attachments) transfer.items.add(await fetchAttachment(attachment));
      input.files = transfer.files;
      input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await adapter.waitUntilSendReady();
    await send("ready-to-submit", { note: "提示词与附件已写入可见页面" });
    setStatus("附件和提示词已就绪，正在自动提交…");
    await submitOnce();
  } catch (error) { filledOnThisPage = false; await handoff(errorMessage(error)); }
  finally { filling = false; }
}

async function submitOnce(): Promise<void> {
  if (!bridge || submitted || submitting) { setStatus("本轮已经提交或正在提交，系统不会再次提交。", "error"); return; }
  const button = adapter.sendButton();
  if (!button || button.disabled) { setStatus("提交按钮未就绪，请确认附件上传完成。", "error"); return; }
  submitting = true;
  try {
    baselineHashes = new Set(await GPTCanvasContent.digestSources(adapter.collectAssistantImages()));
    await chrome.storage.local.set({ [baselineKey()]: [...baselineHashes] });
    await send("submitted", { note: "画布一键生成已授权自动提交；服务已先锁定单次提交" });
    submitted = true;
    panel?.querySelector<HTMLButtonElement>("[data-action=submit]")?.setAttribute("disabled", "true");
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
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
  const blob = await response.blob();
  if (!/^image\/(png|jpeg|webp)$/.test(blob.type)) throw new Error("结果地址未返回受支持的图片");
  const dataUrl = await GPTCanvasContent.blobToDataUrl(blob);
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
  const sources = await GPTCanvasContent.filterNewSources(adapter.collectAssistantImages(), baselineHashes);
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

async function observeAndCollect(): Promise<void> {
  if (!bridge || !submitted || observing || bridge.task.status === "completed") return;
  observing = true;
  const deadline = Date.now() + 10 * 60_000; let previous = ""; let stablePolls = 0;
  try {
    setStatus("正在观察本轮生成状态；完成后将自动收图…");
    while (Date.now() < deadline && bridge && bridge.task.status !== "completed") {
      const sources = await GPTCanvasContent.filterNewSources(adapter.collectAssistantImages(), baselineHashes);
      const signature = [...sources].sort().join("\n");
      if (sources.length && !adapter.isGenerating()) {
        stablePolls = signature === previous ? stablePolls + 1 : 1; previous = signature;
        if (stablePolls >= 3) { await collectResults(); return; }
      } else { stablePolls = 0; previous = signature; }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
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
  if (bridge?.task.id !== state.task.id) filledOnThisPage = false;
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

import { isTerminalStatus, type GenerationTask } from "./protocol.js";
import { isAutoBindableTaskPage, isBindableTaskPage, isCanvasTriggerUrl, isChatGptUrl, isTrustedTaskMessage, shouldFocusChatForHandoff, statusForAdapterEvent } from "./background-guards.js";

interface Settings {
  apiRoot: string;
  token: string;
  taskId: string;
  chatTaskId: string;
  chatBindingId: string;
  chatTabId?: number;
  canvasTabId?: number;
}

interface MessageRecord { type?: unknown; taskId?: unknown; event?: unknown; [key: string]: unknown }

const DEFAULTS: Settings = {
  apiRoot: "http://127.0.0.1:3220",
  token: "",
  taskId: "",
  chatTaskId: "",
  chatBindingId: ""
};

class BridgeApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function asMessage(value: unknown): MessageRecord {
  return typeof value === "object" && value !== null ? value as MessageRecord : {};
}

function normalizeApiRoot(value: unknown): string {
  if (typeof value !== "string") throw new Error("本地服务地址无效");
  const url = new URL(value.trim());
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
    throw new Error("本地服务必须使用 http://127.0.0.1 或 http://localhost");
  }
  return url.origin;
}

async function settings(): Promise<Settings> {
  return { ...DEFAULTS, ...await chrome.storage.local.get(DEFAULTS) } as Settings;
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const current = await settings();
  if (!current.token) throw new BridgeApiError(401, "AUTH_REQUIRED", "请先保存本地桥接令牌");
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${current.apiRoot}${path}`, {
      ...options,
      signal: controller.signal,
      headers: { "content-type": "application/json", "x-bridge-token": current.token, ...(options.headers ?? {}) }
    });
    const data = await response.json() as { error?: { code?: string; message?: string } } & T;
    if (!response.ok) throw new BridgeApiError(response.status, data.error?.code ?? "REQUEST_FAILED", data.error?.message ?? "本地服务请求失败");
    return data;
  } finally { clearTimeout(timer); }
}

async function currentTask(): Promise<GenerationTask | null> {
  const current = await settings();
  if (current.taskId) {
    try {
      const response = await api<{ task: GenerationTask }>(`/api/v1/tasks/${encodeURIComponent(current.taskId)}`);
      if (!isTerminalStatus(response.task.status)) return response.task;
      await chrome.storage.local.set({ taskId: "", chatTaskId: "", chatBindingId: "", chatTabId: null, canvasTabId: null });
    } catch (error) {
      if (error instanceof BridgeApiError && error.status === 404) {
        await chrome.storage.local.set({ taskId: "", chatTaskId: "", chatBindingId: "", chatTabId: null, canvasTabId: null });
      } else throw error;
    }
  }
  return (await api<{ task: GenerationTask | null }>("/api/v1/tasks/active")).task;
}

async function requirePageTask(message: MessageRecord, sender: { tab?: { id?: number; url?: string } }): Promise<GenerationTask> {
  if (typeof message.taskId !== "string" || !/^task_[A-Za-z0-9_-]+$/.test(message.taskId)) {
    throw new Error("页面消息缺少有效任务 ID");
  }
  const current = await settings();
  const task = (await api<{ task: GenerationTask }>(`/api/v1/tasks/${encodeURIComponent(message.taskId)}`)).task;
  if (!isTrustedTaskMessage(task, message.taskId, sender.tab?.id, sender.tab?.url, message.bindingId, current.chatBindingId)) {
    throw new Error("页面消息与绑定任务或标签页不一致");
  }
  if (current.chatTabId !== sender.tab?.id) await chrome.storage.local.set({ chatTabId: sender.tab?.id });
  return task;
}

async function bindTab(task: GenerationTask, tabId: number): Promise<string> {
  const chatBindingId = crypto.randomUUID();
  await chrome.storage.local.set({ taskId: task.id, chatTaskId: task.id, chatBindingId, chatTabId: tabId });
  return chatBindingId;
}

async function openTask(task: GenerationTask): Promise<{ task: GenerationTask; tabId: number; bindingId: string; reused: boolean }> {
  const target = task.target.chatMode === "existing" && task.target.chatUrl ? task.target.chatUrl : "https://chatgpt.com/";
  const current = await settings();
  if (current.chatTaskId === task.id && typeof current.chatTabId === "number") {
    try {
      const tab = await chrome.tabs.get(current.chatTabId) as { id: number; url?: string };
      const bindingId = await bindTab(task, tab.id);
      if (!isChatGptUrl(tab.url)) await chrome.tabs.update(tab.id, { url: target, active: false });
      else {
        await notifyPage(tab.id, task);
      }
      return { task, tabId: tab.id, bindingId, reused: true };
    } catch { /* closed tab; create a new bound tab */ }
  }
  const tab = await chrome.tabs.create({ url: "about:blank", active: false }) as { id: number };
  const bindingId = await bindTab(task, tab.id);
  await chrome.tabs.update(tab.id, { url: target, active: false });
  return { task, tabId: tab.id, bindingId, reused: false };
}

async function notifyPage(tabId: number, task: GenerationTask): Promise<void> {
  const current = await settings();
  try { await chrome.tabs.sendMessage(tabId, { type: "task-ready", task, apiRoot: current.apiRoot, token: current.token, bindingId: current.chatBindingId }); }
  catch { /* content script requests state after page load */ }
}

chrome.tabs.onUpdated.addListener(async (tabId: number, change: { status?: string }, tab: { url?: string }) => {
  if (change.status !== "complete" || !isChatGptUrl(tab.url)) return;
  const current = await settings();
  if (!current.taskId || current.chatTabId !== tabId) return;
  try {
    const task = await currentTask(); if (task && task.id === current.taskId) await notifyPage(tabId, task);
  } catch { /* service unavailable: leave page untouched */ }
});

chrome.runtime.onMessage.addListener((raw: unknown, sender: { tab?: { id?: number; url?: string } }, sendResponse: (value: unknown) => void) => {
  const message = asMessage(raw);
  (async () => {
    if (message.type === "popup-get-state") {
      sendResponse({ ok: true, task: await currentTask(), settings: await settings() }); return;
    }
    if (message.type === "canvas-run-task") {
      if (!isCanvasTriggerUrl(sender.tab?.url) || typeof sender.tab?.id !== "number") {
        throw new Error("自动任务只能从本地画布触发");
      }
      if (typeof message.taskId !== "string" || !/^task_[A-Za-z0-9_-]+$/.test(message.taskId)) {
        throw new Error("画布自动任务 ID 无效");
      }
      let task = (await api<{ task: GenerationTask }>(`/api/v1/tasks/${encodeURIComponent(message.taskId)}`)).task;
      if (isTerminalStatus(task.status)) throw new Error("画布任务已经结束，不能再次自动提交");
      if (task.status === "queued") {
        task = (await api<{ task: GenerationTask }>(`/api/v1/tasks/${task.id}/claim`, { method: "POST", body: "{}" })).task;
      }
      await chrome.storage.local.set({ taskId: task.id, canvasTabId: sender.tab.id });
      const opened = await openTask(task);
      sendResponse({ ok: true, ...opened }); return;
    }
    if (message.type === "popup-save") {
      const apiRoot = normalizeApiRoot(message.apiRoot); const token = typeof message.token === "string" ? message.token.trim() : "";
      if (!token) throw new Error("本地桥接令牌不能为空");
      await chrome.storage.local.set({ apiRoot, token });
      const health = await api<{ ok: boolean; schemaVersion: string }>("/health");
      sendResponse({ ok: true, health }); return;
    }
    if (message.type === "popup-claim") {
      const candidate = await currentTask(); if (!candidate) throw new Error("本地服务中没有待处理任务");
      const task = candidate.status === "queued"
        ? (await api<{ task: GenerationTask }>(`/api/v1/tasks/${candidate.id}/claim`, { method: "POST", body: "{}" })).task
        : candidate;
      await chrome.storage.local.set({ taskId: task.id }); sendResponse({ ok: true, task }); return;
    }
    if (message.type === "popup-open") {
      const task = await currentTask(); if (!task) throw new Error("请先领取任务");
      const opened = await openTask(task); sendResponse({ ok: true, ...opened }); return;
    }
    if (message.type === "adapter-bind-current") {
      const task = await currentTask();
      if (!task || !isBindableTaskPage(task, sender.tab?.id, sender.tab?.url)) throw new Error("当前页面不是可绑定的 ChatGPT 任务页");
      const current = await settings();
      const bindingId = await bindTab(task, sender.tab!.id!);
      sendResponse({ ok: true, task, apiRoot: current.apiRoot, token: current.token, bindingId }); return;
    }
    if (message.type === "adapter-auto-bind-current") {
      const task = await currentTask();
      if (!task || !isAutoBindableTaskPage(task, sender.tab?.id, sender.tab?.url)) {
        throw new Error("当前页面不满足自动绑定条件");
      }
      const current = await settings();
      const bindingId = await bindTab(task, sender.tab!.id!);
      sendResponse({ ok: true, task, apiRoot: current.apiRoot, token: current.token, bindingId }); return;
    }
    if (message.type === "adapter-get-state") {
      const current = await settings(); const task = await currentTask();
      if (!task || sender.tab?.id !== current.chatTabId || task.id !== current.taskId) {
        sendResponse({ ok: true, task: null }); return;
      }
      sendResponse({ ok: true, task, apiRoot: current.apiRoot, token: current.token, bindingId: current.chatBindingId }); return;
    }
    if (message.type === "adapter-event") {
      const task = await requirePageTask(message, sender); const event = typeof message.event === "string" ? message.event : "";
      if (event === "handoff") {
        const reason = typeof message.reason === "string" ? message.reason : "网页适配需要人工接管";
        const response = await api<{ task: GenerationTask }>(`/api/v1/tasks/${task.id}/handoff`, {
          method: "POST",
          body: JSON.stringify({ reason, completedSteps: Array.isArray(message.completedSteps) ? message.completedSteps : [], by: "extension" })
        });
        if (shouldFocusChatForHandoff(reason) && typeof sender.tab?.id === "number") {
          await chrome.tabs.update(sender.tab.id, { active: true });
        }
        sendResponse({ ok: true, task: response.task }); return;
      }
      if (event === "completed") {
        const response = await api<{ task: GenerationTask }>(`/api/v1/tasks/${task.id}/complete`, { method: "POST", body: JSON.stringify({ by: "extension" }) });
        if (response.task.status === "completed") {
          const current = await settings();
          if (typeof current.canvasTabId === "number") {
            try { await chrome.tabs.sendMessage(current.canvasTabId, { type: "canvas-task-completed", taskId: response.task.id }); }
            catch { /* canvas polling remains as fallback */ }
          }
          await chrome.storage.local.set({ taskId: "", chatTaskId: "", chatBindingId: "", chatTabId: null, canvasTabId: null });
        }
        sendResponse({ ok: true, task: response.task }); return;
      }
      const status = statusForAdapterEvent(event);
      if (!status) throw new Error("未知页面状态事件");
      const response = await api<{ task: GenerationTask }>(`/api/v1/tasks/${task.id}/status`, {
        method: "POST", body: JSON.stringify({ status, by: "extension", note: typeof message.note === "string" ? message.note : "" })
      });
      sendResponse({ ok: true, task: response.task }); return;
    }
    throw new Error("未知扩展操作");
  })().catch((error: unknown) => sendResponse({
    ok: false,
    error: error instanceof Error ? error.message : "扩展发生未知错误",
    code: error instanceof BridgeApiError ? error.code : "EXTENSION_ERROR"
  }));
  return true;
});

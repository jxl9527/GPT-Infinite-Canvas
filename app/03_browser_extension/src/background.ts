import { generationProviderOf, isTerminalStatus, type GenerationTask } from "./protocol.js";
import {
  isAutoBindableTaskPage,
  isBindableTaskPage,
  isCanvasTriggerUrl,
  isSupportedGenerationUrl,
  isTaskGenerationUrl,
  isTrustedTaskMessage,
  shouldFocusChatForHandoff,
  statusForAdapterEvent
} from "./background-guards.js";

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

interface TaskBinding { taskId: string; tabId: number; bindingId: string; canvasTabId?: number | undefined }
const bindingKey = (id: string) => `canvas-binding:${id}`;
const openingTasks = new Map<string, Promise<{ task: GenerationTask; tabId: number; bindingId: string; reused: boolean }>>();

async function taskBinding(id: string): Promise<TaskBinding | null> {
  const key = bindingKey(id);
  const value = (await chrome.storage.local.get(key))[key] as TaskBinding | undefined;
  if (value?.taskId === id && typeof value.tabId === "number") return value;
  const old = await settings();
  if (old.chatTaskId === id && typeof old.chatTabId === "number" && old.chatBindingId) {
    const migrated = { taskId: id, tabId: old.chatTabId, bindingId: old.chatBindingId, canvasTabId: old.canvasTabId };
    await chrome.storage.local.set({ [key]: migrated });
    return migrated;
  }
  return null;
}

async function bindingForTab(tabId: number | undefined): Promise<TaskBinding | null> {
  if (tabId === undefined) return null;
  const values = await chrome.storage.local.get(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith("canvas-binding:") && value && typeof value === "object" && (value as TaskBinding).tabId === tabId) return value as TaskBinding;
  }
  const old = await settings();
  return old.chatTabId === tabId && old.chatTaskId ? taskBinding(old.chatTaskId) : null;
}

async function pageTask(tabId: number | undefined): Promise<GenerationTask | null> {
  const binding = await bindingForTab(tabId);
  if (!binding) return null;
  const { task } = await api<{ task: GenerationTask }>(`/api/v1/tasks/${encodeURIComponent(binding.taskId)}`);
  return isTerminalStatus(task.status) ? null : task;
}

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
  const task = (await api<{ task: GenerationTask }>(`/api/v1/tasks/${encodeURIComponent(message.taskId)}`)).task;
  const binding = await taskBinding(task.id);
  if (!binding || binding.tabId !== sender.tab?.id || !isTrustedTaskMessage(task, message.taskId, sender.tab?.id, sender.tab?.url, message.bindingId, binding.bindingId)) {
    throw new Error("页面消息与绑定任务或标签页不一致");
  }
  return task;
}

async function insertTrustedText(tabId: number, text: string): Promise<void> {
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 2
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8
    });
    await chrome.debugger.sendCommand(target, "Input.insertText", { text });
  } catch (error) {
    throw new Error(`无法向 Google Flow 发送可信文本输入：${error instanceof Error ? error.message : "Chrome 调试接口失败"}`);
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target); } catch { /* tab closed or debugger already detached */ }
    }
  }
}

async function clickTrustedPoint(tabId: number, x: number, y: number): Promise<void> {
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });
  } catch (error) {
    throw new Error(`无法点击 Google Flow 创建按钮：${error instanceof Error ? error.message : "Chrome 调试接口失败"}`);
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target); } catch { /* tab closed or debugger already detached */ }
    }
  }
}

async function bindTab(task: GenerationTask, tabId: number, canvasTabId?: number): Promise<string> {
  const previous = await taskBinding(task.id);
  const occupied = await bindingForTab(tabId);
  if (occupied && occupied.taskId !== task.id) throw new Error("该网页已绑定另一个任务");
  const chatBindingId = previous?.tabId === tabId ? previous.bindingId : crypto.randomUUID();
  const binding: TaskBinding = { taskId: task.id, tabId, bindingId: chatBindingId, canvasTabId: canvasTabId ?? previous?.canvasTabId };
  await chrome.storage.local.set({ [bindingKey(task.id)]: binding });
  if (!task.simpleRender) await chrome.storage.local.set({ taskId: task.id, chatTaskId: task.id, chatBindingId, chatTabId: tabId, canvasTabId: binding.canvasTabId });
  return chatBindingId;
}

async function taskTargetUrl(task: GenerationTask): Promise<string> {
  if (task.target.chatMode === "existing" && task.target.chatUrl) return task.target.chatUrl;
  if (generationProviderOf(task.target) !== "google-flow") return "https://chatgpt.com/";
  const localProjectId = task.target.localProject?.id;
  if (!localProjectId) return "https://labs.google/fx/zh/tools/flow";
  const key = `flow-project-binding:${localProjectId}`;
  const stored = await chrome.storage.local.get(key) as Record<string, unknown>;
  const binding = stored[key] as { url?: unknown } | undefined;
  return typeof binding?.url === "string" && binding.url.startsWith("https://labs.google/")
    ? binding.url
    : "https://labs.google/fx/zh/tools/flow";
}

async function openTaskUnshared(task: GenerationTask, canvasTabId?: number): Promise<{ task: GenerationTask; tabId: number; bindingId: string; reused: boolean }> {
  const target = await taskTargetUrl(task);
  const current = await taskBinding(task.id);
  if (current) {
    try {
      const tab = await chrome.tabs.get(current.tabId) as { id: number; url?: string };
      const bindingId = await bindTab(task, tab.id, canvasTabId);
        if (!isTaskGenerationUrl(task, tab.url)) {
          if (task.submittedAt) throw new Error("已提交任务的网页已离开原会话，不会重新发送");
          await chrome.tabs.update(tab.id, { url: target, active: false });
        }
      else {
        await notifyPage(tab.id, task);
      }
      return { task, tabId: tab.id, bindingId, reused: true };
    } catch { /* closed tab; create a new bound tab */ }
  }
  if (task.submittedAt) throw new Error("已提交任务的网页已关闭，请恢复原会话后接管；不会重新发送");
  const tab = await chrome.tabs.create({ url: "about:blank", active: false }) as { id: number };
  const bindingId = await bindTab(task, tab.id, canvasTabId);
  await chrome.tabs.update(tab.id, { url: target, active: false });
  return { task, tabId: tab.id, bindingId, reused: false };
}

function openTask(task: GenerationTask, canvasTabId?: number) {
  const pending = openingTasks.get(task.id);
  if (pending) return pending;
  const operation = openTaskUnshared(task, canvasTabId).finally(() => openingTasks.delete(task.id));
  openingTasks.set(task.id, operation);
  return operation;
}

async function notifyPage(tabId: number, task: GenerationTask): Promise<void> {
  const current = await settings();
  const binding = await taskBinding(task.id);
  if (!binding || binding.tabId !== tabId) return;
  try { await chrome.tabs.sendMessage(tabId, { type: "task-ready", task, apiRoot: current.apiRoot, token: current.token, bindingId: binding.bindingId }); }
  catch { /* content script requests state after page load */ }
}

chrome.tabs.onUpdated.addListener(async (tabId: number, change: { status?: string }, tab: { url?: string }) => {
  if (change.status !== "complete" || !isSupportedGenerationUrl(tab.url)) return;
  try {
    const task = await pageTask(tabId);
    if (task && isTaskGenerationUrl(task, tab.url)) await notifyPage(tabId, task);
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
        const opened = await openTask(task, sender.tab.id);
        if (message.focus === true) await chrome.tabs.update(opened.tabId, { active: true });
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
      const task = await pageTask(sender.tab?.id) ?? await currentTask();
      if (task?.simpleRender && !(await bindingForTab(sender.tab?.id))) throw new Error("并发任务只能使用各自绑定网页，请从画布定位任务");
      if (!task || !isBindableTaskPage(task, sender.tab?.id, sender.tab?.url)) throw new Error("当前页面不是与任务来源匹配的生成页");
      const current = await settings();
      const bindingId = await bindTab(task, sender.tab!.id!);
      sendResponse({ ok: true, task, apiRoot: current.apiRoot, token: current.token, bindingId }); return;
    }
    if (message.type === "adapter-auto-bind-current") {
      const task = await pageTask(sender.tab?.id);
      if (!task || !isAutoBindableTaskPage(task, sender.tab?.id, sender.tab?.url)) {
        throw new Error("当前页面不满足自动绑定条件");
      }
      const current = await settings();
      const bindingId = await bindTab(task, sender.tab!.id!);
      sendResponse({ ok: true, task, apiRoot: current.apiRoot, token: current.token, bindingId }); return;
    }
    if (message.type === "adapter-get-state") {
      const current = await settings(); const task = await pageTask(sender.tab?.id);
      const binding = task ? await taskBinding(task.id) : null;
      if (!task || !binding || sender.tab?.id !== binding.tabId) {
        sendResponse({ ok: true, task: null }); return;
      }
      sendResponse({ ok: true, task, apiRoot: current.apiRoot, token: current.token, bindingId: binding.bindingId }); return;
    }
    if (message.type === "adapter-insert-flow-prompt") {
      const task = await requirePageTask(message, sender);
      if (
        generationProviderOf(task.target) !== "google-flow"
        || typeof sender.tab?.id !== "number"
        || typeof message.text !== "string"
        || message.text !== task.prompt
      ) {
        throw new Error("Google Flow 可信文本输入与当前绑定任务不一致");
      }
      await insertTrustedText(sender.tab.id, message.text);
      sendResponse({ ok: true }); return;
    }
    if (message.type === "adapter-click-flow-create") {
      const task = await requirePageTask(message, sender);
      const x = typeof message.x === "number" ? message.x : Number.NaN;
      const y = typeof message.y === "number" ? message.y : Number.NaN;
      if (
        generationProviderOf(task.target) !== "google-flow"
        || typeof sender.tab?.id !== "number"
        || !task.submittedAt
        || !Number.isFinite(x)
        || !Number.isFinite(y)
        || x < 0
        || y < 0
        || x > 20_000
        || y > 20_000
      ) {
        throw new Error("Google Flow 可信创建点击与已锁定任务不一致");
      }
      await clickTrustedPoint(sender.tab.id, x, y);
      sendResponse({ ok: true }); return;
    }
    if (message.type === "adapter-focus-current") {
      await requirePageTask(message, sender);
      if (typeof sender.tab?.id !== "number") throw new Error("当前生成标签页无效");
      await chrome.tabs.update(sender.tab.id, { active: true });
      sendResponse({ ok: true }); return;
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
          const binding = await taskBinding(task.id);
          if (typeof binding?.canvasTabId === "number") {
            try { await chrome.tabs.sendMessage(binding.canvasTabId, { type: "canvas-task-completed", taskId: response.task.id }); }
            catch { /* canvas polling remains as fallback */ }
          }
          await chrome.storage.local.remove(bindingKey(task.id));
          const current = await settings();
          if (current.taskId === task.id) await chrome.storage.local.set({ taskId: "", chatTaskId: "", chatBindingId: "", chatTabId: null, canvasTabId: null });
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

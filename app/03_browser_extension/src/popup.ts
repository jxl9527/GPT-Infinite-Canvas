interface PopupTask {
  id: string;
  status: string;
  taskType: string;
  target: {
    provider?: "chatgpt" | "google-flow";
    chatMode: "new" | "existing";
    outputCount?: 1 | 2 | 3 | 4;
  };
  attachments: unknown[];
}

interface PopupResponse {
  ok: boolean;
  error?: string;
  task?: PopupTask | null;
  settings?: { apiRoot: string; token: string };
  health?: { schemaVersion: string };
}

function element<T extends HTMLElement>(id: string): T {
  const target = document.getElementById(id);
  if (!target) throw new Error(`弹窗元素缺失：${id}`);
  return target as T;
}

const apiRoot = element<HTMLInputElement>("apiRoot");
const token = element<HTMLInputElement>("token");
const taskId = element<HTMLElement>("taskId");
const status = element<HTMLElement>("status");
const detail = element<HTMLElement>("detail");
const message = element<HTMLElement>("message");
const openButton = element<HTMLButtonElement>("open");

function show(text: string, error = false): void {
  message.textContent = text; message.dataset.error = String(error);
}

function render(task: PopupTask | null | undefined): void {
  const provider = task?.target.provider === "google-flow" ? "Google Flow" : "ChatGPT";
  taskId.textContent = task?.id ?? "未领取";
  status.textContent = task?.status ?? "—";
  detail.textContent = task
    ? `${provider}${task.target.outputCount ? ` ×${task.target.outputCount}` : ""} · ${task.taskType} · ${task.attachments.length ? `附件 ${task.attachments.length} 张` : "仅文字"} · ${task.target.chatMode === "existing" ? "已有页面" : "新页面"}`
    : "启动 P1 服务后创建一条任务。";
  openButton.textContent = task ? `在 ${provider} 打开任务 →` : "打开任务 →";
  openButton.disabled = !task;
}

async function send(type: string, value: Record<string, unknown> = {}): Promise<PopupResponse> {
  return chrome.runtime.sendMessage({ type, ...value }) as Promise<PopupResponse>;
}

async function refresh(): Promise<void> {
  const response = await send("popup-get-state"); if (!response.ok) throw new Error(response.error);
  render(response.task); if (response.settings) { apiRoot.value = response.settings.apiRoot; token.value = response.settings.token; }
}

element<HTMLButtonElement>("save").addEventListener("click", async () => {
  try {
    const response = await send("popup-save", { apiRoot: apiRoot.value, token: token.value });
    if (!response.ok) throw new Error(response.error);
    show(`连接有效，协议 ${response.health?.schemaVersion ?? "未知"}。`); await refresh();
  } catch (error) { show(error instanceof Error ? error.message : "保存连接失败", true); }
});

element<HTMLButtonElement>("claim").addEventListener("click", async () => {
  try {
    const response = await send("popup-claim"); if (!response.ok) throw new Error(response.error);
    render(response.task); show("任务已领取。下一步打开与任务匹配的生成页。");
  } catch (error) { show(error instanceof Error ? error.message : "领取任务失败", true); }
});

openButton.addEventListener("click", async () => {
  try {
    const response = await send("popup-open"); if (!response.ok) throw new Error(response.error);
    show("已打开绑定页面。请只使用页面右下角 P1 浮层操作。");
  } catch (error) { show(error instanceof Error ? error.message : "打开任务失败", true); }
});

refresh().catch((error: unknown) => show(error instanceof Error ? error.message : "无法读取本地任务", true));

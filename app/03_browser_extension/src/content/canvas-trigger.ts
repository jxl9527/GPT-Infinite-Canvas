interface CanvasAutomationResponse {
  ok: boolean;
  error?: string;
  task?: { id: string; status: string };
}

const RUN_EVENT = "gpt-canvas-run-task";
const STATUS_EVENT = "gpt-canvas-automation-status";
const COMPLETED_EVENT = "gpt-canvas-task-completed";
const TASK_ATTRIBUTE = "data-gpt-canvas-task-id";
const STATUS_ATTRIBUTE = "data-gpt-canvas-automation-status";
const MESSAGE_ATTRIBUTE = "data-gpt-canvas-automation-message";
const COMPLETED_TASK_ATTRIBUTE = "data-gpt-canvas-completed-task-id";

function publishStatus(status: "ready" | "started" | "error", message: string): void {
  document.documentElement.setAttribute(STATUS_ATTRIBUTE, status);
  document.documentElement.setAttribute(MESSAGE_ATTRIBUTE, message);
  window.dispatchEvent(new Event(STATUS_EVENT));
}

window.addEventListener(RUN_EVENT, () => {
  const taskId = document.documentElement.getAttribute(TASK_ATTRIBUTE) ?? "";
  if (!/^task_[A-Za-z0-9_-]+$/.test(taskId)) {
    publishStatus("error", "画布没有提供有效任务 ID");
    return;
  }
  void chrome.runtime.sendMessage({ type: "canvas-run-task", taskId })
    .then((response: CanvasAutomationResponse) => {
      if (!response.ok) throw new Error(response.error ?? "扩展未能启动自动任务");
      publishStatus("started", `任务 ${taskId} 已进入全自动生成链路`);
    })
    .catch((error: unknown) => {
      publishStatus("error", error instanceof Error ? error.message : "扩展自动任务启动失败");
    });
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  const value = typeof message === "object" && message !== null
    ? message as { type?: unknown; taskId?: unknown }
    : {};
  if (value.type !== "canvas-task-completed" || typeof value.taskId !== "string") return;
  document.documentElement.setAttribute(COMPLETED_TASK_ATTRIBUTE, value.taskId);
  window.dispatchEvent(new Event(COMPLETED_EVENT));
});

publishStatus("ready", "全自动桥接扩展 1.2.0 已连接");

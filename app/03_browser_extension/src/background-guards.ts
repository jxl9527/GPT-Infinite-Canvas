import {
  generationProviderOf,
  isGenerationPageUrl,
  isGoogleFlowUrl,
  isTerminalStatus,
  type GenerationStatus,
  type GenerationTask
} from "./protocol.js";

export const ADAPTER_STATUS_EVENTS = {
  "upload-started": "uploading",
  "ready-to-submit": "ready-to-submit",
  submitted: "submitted",
  generating: "generating",
  collecting: "collecting"
} as const satisfies Readonly<Record<string, GenerationStatus>>;

export type AdapterStatusEvent = keyof typeof ADAPTER_STATUS_EVENTS;

export function statusForAdapterEvent(event: string): GenerationStatus | undefined {
  return ADAPTER_STATUS_EVENTS[event as AdapterStatusEvent];
}

export function isTrustedTaskMessage(
  task: GenerationTask | undefined,
  messageTaskId: unknown,
  senderTabId: number | undefined,
  senderUrl: string | undefined,
  messageBindingId: unknown,
  storedBindingId: string
): boolean {
  return Boolean(
    task
    && !isTerminalStatus(task.status)
    && typeof messageTaskId === "string"
    && messageTaskId === task.id
    && typeof senderTabId === "number"
    && isTaskGenerationUrl(task, senderUrl)
    && typeof messageBindingId === "string"
    && messageBindingId.length >= 16
    && messageBindingId === storedBindingId
  );
}

export function isChatGptUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com");
  } catch { return false; }
}

export function isFlowUrl(value: string | undefined): boolean {
  return Boolean(value && isGoogleFlowUrl(value));
}

export function isSupportedGenerationUrl(value: string | undefined): boolean {
  return isChatGptUrl(value) || isFlowUrl(value);
}

export function isTaskGenerationUrl(
  task: GenerationTask | null | undefined,
  value: string | undefined
): boolean {
  return Boolean(task && value && isGenerationPageUrl(value, generationProviderOf(task.target)));
}

export function isCanvasTriggerUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      && url.port === "3230";
  } catch { return false; }
}

export function isBindableTaskPage(
  task: GenerationTask | null | undefined,
  senderTabId: number | undefined,
  senderUrl: string | undefined
): boolean {
  return Boolean(task && !isTerminalStatus(task.status) && typeof senderTabId === "number" && isTaskGenerationUrl(task, senderUrl));
}

export function isAutoBindableTaskPage(
  task: GenerationTask | null | undefined,
  senderTabId: number | undefined,
  senderUrl: string | undefined
): boolean {
  return Boolean(task?.status === "opening-chat" && typeof senderTabId === "number" && isTaskGenerationUrl(task, senderUrl));
}

export function shouldFocusChatForHandoff(reason: unknown): boolean {
  if (typeof reason !== "string") return false;
  return /(登录|登入|未登录|网页验证|安全验证|创建或打开一个项目|Flow.{0,12}项目|login|log in|sign in|verification|verify)/i.test(reason);
}

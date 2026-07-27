export const SCHEMA_VERSION = "1.0" as const;

export const TASK_TYPES = ["new", "edit", "variation", "redraw"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const IMAGE_ROLES = [
  "structure-base",
  "edit-target",
  "annotation-map",
  "style-reference",
  "content-reference"
] as const;
export type ImageRole = (typeof IMAGE_ROLES)[number];

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

export type CanvasAssetKind = "imported" | "generated" | "annotation-export";

export interface CanvasImageFileRecord {
  relativePath: string;
  mime: ImageMime;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

export interface CanvasImageAsset {
  id: `asset_${string}`;
  kind: CanvasAssetKind;
  originalName: string;
  original: CanvasImageFileRecord;
  display?: CanvasImageFileRecord;
  thumbnail?: CanvasImageFileRecord;
  createdAt: string;
}

export const GENERATION_STATUSES = [
  "draft",
  "queued",
  "opening-chat",
  "uploading",
  "ready-to-submit",
  "submitted",
  "generating",
  "collecting",
  "returning",
  "completed",
  "needs-user",
  "failed",
  "cancelled"
] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

export const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

export const STATUS_TRANSITIONS: Readonly<Record<GenerationStatus, readonly GenerationStatus[]>> = {
  draft: ["queued", "cancelled"],
  queued: ["opening-chat", "needs-user", "failed", "cancelled"],
  "opening-chat": ["uploading", "ready-to-submit", "needs-user", "failed", "cancelled"],
  uploading: ["ready-to-submit", "needs-user", "failed", "cancelled"],
  "ready-to-submit": ["uploading", "submitted", "needs-user", "failed", "cancelled"],
  submitted: ["generating", "collecting", "needs-user", "failed", "cancelled"],
  generating: ["collecting", "needs-user", "failed", "cancelled"],
  collecting: ["returning", "completed", "needs-user", "failed", "cancelled"],
  returning: ["completed", "needs-user", "failed", "cancelled"],
  "needs-user": ["opening-chat", "uploading", "ready-to-submit", "collecting", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: []
};

export const ERROR_CODES = [
  "AUTH_REQUIRED",
  "ORIGIN_REJECTED",
  "TASK_NOT_FOUND",
  "TASK_LOCKED",
  "INVALID_TRANSITION",
  "ALREADY_SUBMITTED",
  "RESULT_STATE_REJECTED",
  "RESULT_MATCHES_ATTACHMENT",
  "DUPLICATE_RESULT",
  "INVALID_ATTACHMENT",
  "CHAT_URL_INVALID",
  "RECOVERY_REQUIRED",
  "INVALID_INPUT",
  "INTERNAL_ERROR"
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  AUTH_REQUIRED: 401,
  ORIGIN_REJECTED: 403,
  TASK_NOT_FOUND: 404,
  TASK_LOCKED: 409,
  INVALID_TRANSITION: 409,
  ALREADY_SUBMITTED: 409,
  RESULT_STATE_REJECTED: 409,
  RESULT_MATCHES_ATTACHMENT: 422,
  DUPLICATE_RESULT: 200,
  INVALID_ATTACHMENT: 422,
  CHAT_URL_INVALID: 422,
  RECOVERY_REQUIRED: 422,
  INVALID_INPUT: 422,
  INTERNAL_ERROR: 500
};

export type EventActor = "service" | "extension" | "user" | "recovery" | "test";
export type ChatMode = "new" | "existing";

export interface TaskAttachmentInput {
  role: ImageRole;
  name: string;
  relativePath: string;
}

export interface TaskAttachment extends TaskAttachmentInput {
  id: string;
  mime: ImageMime;
  bytes: number;
  sha256: string;
}

export interface CreateTaskInput {
  taskType: TaskType;
  target: {
    chatMode: ChatMode;
    chatUrl?: string;
  };
  prompt: string;
  attachments: TaskAttachmentInput[];
}

export interface TaskEvent {
  id: string;
  at: string;
  status: GenerationStatus;
  by: EventActor;
  note?: string;
}

export interface GenerationResult {
  id: string;
  createdAt: string;
  filename: string;
  mime: ImageMime;
  bytes: number;
  sha256: string;
  relativePath: string;
  source: "visible-page" | "manual-import";
}

export interface HandoffRecord {
  at: string;
  by: EventActor;
  reason: string;
  completedSteps: GenerationStatus[];
}

export interface GenerationTask {
  schemaVersion: typeof SCHEMA_VERSION;
  id: `task_${string}`;
  idempotencyKey: string;
  taskType: TaskType;
  target: {
    chatMode: ChatMode;
    chatUrl?: string;
  };
  prompt: string;
  attachments: TaskAttachment[];
  status: GenerationStatus;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  events: TaskEvent[];
  results: GenerationResult[];
  handoff?: HandoffRecord;
}

export class ProtocolError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.httpStatus = ERROR_HTTP_STATUS[code];
  }
}

export function isTerminalStatus(status: GenerationStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function canTransition(from: GenerationStatus, to: GenerationStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

export function isChatUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com");
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new ProtocolError("INVALID_INPUT", `${field} 无效`);
  }
  return value.trim();
}

export function parseCreateTaskInput(value: unknown): CreateTaskInput {
  if (!isRecord(value)) throw new ProtocolError("INVALID_INPUT", "任务必须是 JSON 对象");
  if (!(TASK_TYPES as readonly unknown[]).includes(value.taskType)) {
    throw new ProtocolError("INVALID_INPUT", "taskType 无效");
  }
  if (!isRecord(value.target) || (value.target.chatMode !== "new" && value.target.chatMode !== "existing")) {
    throw new ProtocolError("INVALID_INPUT", "target.chatMode 无效");
  }
  const chatMode: ChatMode = value.target.chatMode;
  const chatUrl = typeof value.target.chatUrl === "string" ? value.target.chatUrl.trim() : undefined;
  if (chatMode === "existing" && (!chatUrl || !isChatUrl(chatUrl))) {
    throw new ProtocolError("CHAT_URL_INVALID", "已有对话必须提供有效的 ChatGPT 地址");
  }
  const prompt = requiredString(value.prompt, "prompt", 20_000);
  if (!Array.isArray(value.attachments) || value.attachments.length > 2) {
    throw new ProtocolError("INVALID_ATTACHMENT", "attachments 必须为最多两个附件的数组");
  }
  const attachments = value.attachments.map((attachment, index): TaskAttachmentInput => {
    if (!isRecord(attachment) || !(IMAGE_ROLES as readonly unknown[]).includes(attachment.role)) {
      throw new ProtocolError("INVALID_ATTACHMENT", `附件 ${index + 1} role 无效`);
    }
    return {
      role: attachment.role as ImageRole,
      name: requiredString(attachment.name, `附件 ${index + 1} name`, 500),
      relativePath: requiredString(attachment.relativePath, `附件 ${index + 1} relativePath`, 1_000)
    };
  });
  const target = chatUrl ? { chatMode, chatUrl } : { chatMode };
  return { taskType: value.taskType as TaskType, target, prompt, attachments };
}

export function assertGenerationTask(value: unknown): asserts value is GenerationTask {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || typeof value.id !== "string" || !value.id.startsWith("task_")) {
    throw new ProtocolError("INTERNAL_ERROR", "任务数据版本或标识无效");
  }
  if (!(GENERATION_STATUSES as readonly unknown[]).includes(value.status) || !Array.isArray(value.events) || !Array.isArray(value.results)) {
    throw new ProtocolError("INTERNAL_ERROR", "任务状态、事件或结果数据无效");
  }
}

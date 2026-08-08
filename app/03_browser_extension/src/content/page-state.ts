namespace GPTCanvasContent {
  export type PageProvider = "chatgpt" | "google-flow";
  export type ResponseMode = "image" | "text" | "image-or-text";

  export interface AdapterTaskContext {
    localProject?: {
      id: string;
      name: string;
    };
    outputCount?: 1 | 2 | 3 | 4;
  }

  export interface GenerationPageAdapter {
    readonly provider: PageProvider;
    readonly label: string;
    preparePage(context: AdapterTaskContext): Promise<void>;
    composer(): HTMLElement | null;
    uploadInput(): HTMLInputElement | null;
    waitForUploadInput(timeoutMs?: number): Promise<HTMLInputElement>;
    sendButton(): HTMLButtonElement | null;
    isSendReady(): boolean;
    isGenerating(): boolean;
    generationFailureReason?(): string | null;
    completedWithoutGeneratedImage?(): boolean;
    waitForComposer(timeoutMs?: number): Promise<HTMLElement>;
    waitUntilSendReady(timeoutMs?: number): Promise<void>;
    collectGeneratedImages(): string[];
    collectAssistantText?(): string;
    tryReuseAttachment?(remoteName: string): Promise<boolean>;
  }

  const AUTO_FILL_STATUSES = new Set(["opening-chat", "uploading", "ready-to-submit"]);

  export function shouldAutoFill(status: string): boolean {
    return AUTO_FILL_STATUSES.has(status);
  }

  export type ActivationMode = "fill" | "observe" | "manual";

  export function activationMode(status: string, submittedAt?: string): ActivationMode {
    if (status === "needs-user") return "manual";
    if (submittedAt || ["submitted", "generating", "collecting", "returning"].includes(status)) return "observe";
    if (shouldAutoFill(status)) return "fill";
    return "manual";
  }

  export async function digestSource(source: string): Promise<string> {
    const bytes = new TextEncoder().encode(String(source));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  export async function digestSources(sources: readonly string[]): Promise<string[]> {
    return Promise.all([...new Set(sources)].map(digestSource));
  }

  export async function filterNewSources(sources: readonly string[], baselineHashes: ReadonlySet<string>): Promise<string[]> {
    const unique = [...new Set(sources)];
    const checks = await Promise.all(unique.map(async (source) => ({ source, hash: await digestSource(source) })));
    return checks.filter((item) => !baselineHashes.has(item.hash)).map((item) => item.source);
  }

  export function parseSrcset(value: string): string[] {
    return value.split(",").map((item) => item.trim().split(/\s+/)[0] ?? "").filter(Boolean);
  }

  export function isAssistantConversationTurn(authorRoles: readonly string[]): boolean {
    return !authorRoles.includes("user");
  }

  export function preferredResponseKind(
    mode: ResponseMode,
    imageCount: number,
    textLength: number
  ): "image" | "text" | null {
    if (mode !== "text" && imageCount > 0) return "image";
    if (mode !== "image" && textLength >= 20) return "text";
    return null;
  }

  export function containsSandboxImagePath(value: string): boolean {
    return /(?:^|[\s`'"(])\/mnt\/data\/[^\s`'"<>]+\.(?:png|jpe?g|webp)(?=$|[\s`'"),])/i.test(value);
  }

  export function isCollectableGeneratedImage(source: string, width: number, height: number): boolean {
    let protocol = "";
    try { protocol = new URL(source, location.href).protocol; }
    catch { return false; }
    if (!new Set(["https:", "http:", "blob:"]).has(protocol)) return false;
    return Math.max(width, height) >= 256 && Math.min(width, height) >= 128;
  }

  export function detectSupportedImageMime(bytes: Uint8Array, declaredMime = ""): "image/png" | "image/jpeg" | "image/webp" | null {
    if (bytes.length >= 8
      && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.length >= 12
      && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
    const normalized = declaredMime.split(";", 1)[0]?.trim().toLowerCase();
    return normalized === "image/png" || normalized === "image/jpeg" || normalized === "image/webp"
      ? normalized
      : null;
  }

  export function isFlowWorkspaceLaunchLabel(value: string): boolean {
    return /^(create with google flow|try google flow|使用 google flow 创作|开始使用 google flow)$/i
      .test(value.replace(/\s+/g, " ").trim());
  }

  export function reusableFlowFilename(sha256: string, mime: string): string {
    const extension = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
    return `canvas_${sha256.slice(0, 16).toLowerCase()}.${extension}`;
  }

  export function hasCompletePrompt(expected: string, received: string): boolean {
    const canonical = (value: string) => value
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, "");
    return canonical(expected) === canonical(received);
  }

  export async function fetchWithTimeout(
    input: RequestInfo | URL,
    options: RequestInit = {},
    timeoutMs = 15_000,
    fetchImpl: typeof fetch = fetch
  ): Promise<Response> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetchImpl(input, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); }
  }

  export function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("图片编码失败"));
      reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
      reader.readAsDataURL(blob);
    });
  }
}

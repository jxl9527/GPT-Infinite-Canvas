namespace GPTCanvasContent {
  const AUTO_FILL_STATUSES = new Set(["opening-chat", "uploading", "ready-to-submit"]);

  export function shouldAutoFill(status: string): boolean {
    return AUTO_FILL_STATUSES.has(status);
  }

  export type ActivationMode = "fill" | "observe" | "manual";

  export function activationMode(status: string, submittedAt?: string): ActivationMode {
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

export function normalizeCustomGptUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com")) {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "g" || !parts[1]?.startsWith("g-")) return null;
    return `${url.origin}/g/${parts[1]}`;
  } catch {
    return null;
  }
}

export const FIXED_CUSTOM_GPT_STORAGE_KEY = "gpt-canvas.fixed-custom-gpt-url";

export function resolveFixedCustomGptUrl(storedValue: string | null, projectValue: string): string {
  return normalizeCustomGptUrl(storedValue ?? "") ?? normalizeCustomGptUrl(projectValue) ?? "";
}

export function generationTargetForCustomGpt(customGptUrl: string) {
  const normalized = normalizeCustomGptUrl(customGptUrl);
  return normalized
    ? { provider: "chatgpt" as const, chatMode: "existing" as const, chatUrl: normalized }
    : { provider: "chatgpt" as const, chatMode: "new" as const };
}

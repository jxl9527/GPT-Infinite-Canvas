namespace GPTCanvasContent {
  const SELECTORS = Object.freeze({
    composer: "#prompt-textarea, textarea[data-testid='prompt-textarea'], div[contenteditable='true'][data-lexical-editor='true'], [contenteditable='true'][role='textbox']",
    upload: "input[type='file'][accept*='image'], input[type='file']",
    send: "button[data-testid='send-button'], button[aria-label*='Send'], button[aria-label*='发送']",
    stop: "button[data-testid='stop-button'], button[aria-label*='Stop'], button[aria-label*='停止']",
    assistantTurn: "section[data-testid^='conversation-turn-'], article[data-testid^='conversation-turn-']",
    images: "img[src]"
  });

  function normalizedSources(nodes: Iterable<Element>): string[] {
    const sources: string[] = [];
    for (const node of nodes) {
      if (!(node instanceof HTMLImageElement)) continue;
      const source = node.currentSrc || node.src || "";
      if (isCollectableGeneratedImage(source, node.naturalWidth, node.naturalHeight)) sources.push(source);
    }
    return [...new Set(sources)];
  }

  export class ChatGptAdapter {
    readonly provider = "chatgpt" as const;
    readonly label = "ChatGPT";

    constructor(readonly root: Document) {}

    async preparePage(_context: AdapterTaskContext): Promise<void> {}
    private assistantTurns(): HTMLElement[] {
      return [...this.root.querySelectorAll<HTMLElement>(SELECTORS.assistantTurn)]
        .filter((turn) => {
          const roles = [...turn.querySelectorAll<HTMLElement>("[data-message-author-role]")]
            .map((node) => node.getAttribute("data-message-author-role") ?? "");
          return roles.includes("assistant") && isAssistantConversationTurn(roles);
        });
    }
    composer(): HTMLElement | null { return this.root.querySelector<HTMLElement>(SELECTORS.composer); }
    uploadInput(): HTMLInputElement | null { return this.root.querySelector<HTMLInputElement>(SELECTORS.upload); }
    sendButton(): HTMLButtonElement | null { return this.root.querySelector<HTMLButtonElement>(SELECTORS.send); }
    isSendReady(): boolean { const button = this.sendButton(); return Boolean(button && !button.disabled); }
    isGenerating(): boolean { return Boolean(this.root.querySelector(SELECTORS.stop)); }

    async waitForComposer(timeoutMs = 120_000): Promise<HTMLElement> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const target = this.composer();
        if (target) return target;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("等待 ChatGPT 输入区超时；请检查登录状态或网页验证");
    }

    collectGeneratedImages(): string[] {
      const turns = this.assistantTurns();
      const latestTurn = turns[turns.length - 1];
      return latestTurn ? normalizedSources(latestTurn.querySelectorAll(SELECTORS.images)) : [];
    }

    collectAssistantText(): string {
      const turns = this.assistantTurns();
      const latestTurn = turns[turns.length - 1];
      if (!latestTurn) return "";
      const clone = latestTurn.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("button, img, svg, style, script").forEach((node) => node.remove());
      return (clone.innerText || clone.textContent || "")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    completedWithoutGeneratedImage(): boolean {
      const turns = this.assistantTurns();
      const latestTurn = turns[turns.length - 1];
      if (!latestTurn || normalizedSources(latestTurn.querySelectorAll(SELECTORS.images)).length) return false;
      return this.collectAssistantText().replace(/\s+/g, " ").trim().length >= 20;
    }

    async waitForUploadInput(timeoutMs = 10_000): Promise<HTMLInputElement> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const input = this.uploadInput();
        if (input) return input;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("未找到 ChatGPT 附件输入控件");
    }

    async waitUntilSendReady(timeoutMs = 30_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (this.isSendReady()) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("ChatGPT 提交按钮在 30 秒内未就绪");
    }
  }
}

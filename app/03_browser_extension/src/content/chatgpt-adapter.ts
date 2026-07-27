namespace GPTCanvasContent {
  const SELECTORS = Object.freeze({
    composer: "#prompt-textarea, textarea[data-testid='prompt-textarea'], div[contenteditable='true'][data-lexical-editor='true'], [contenteditable='true'][role='textbox']",
    upload: "input[type='file'][accept*='image'], input[type='file']",
    send: "button[data-testid='send-button'], button[aria-label*='Send'], button[aria-label*='发送']",
    stop: "button[data-testid='stop-button'], button[aria-label*='Stop'], button[aria-label*='停止']",
    assistantTurn: "article[data-testid*='conversation-turn'], [data-testid^='conversation-turn'], [data-message-author-role='assistant']",
    images: "img[src], source[srcset]"
  });

  function normalizedSources(nodes: Iterable<Element>): string[] {
    const sources: string[] = [];
    for (const node of nodes) {
      if (node instanceof HTMLSourceElement) sources.push(...parseSrcset(node.srcset));
      else if (node instanceof HTMLImageElement) sources.push(node.currentSrc || node.src || "");
    }
    return [...new Set(sources.filter((source) => source && !source.startsWith("data:")))];
  }

  export class ChatGptAdapter {
    constructor(readonly root: Document) {}

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

    collectAssistantImages(): string[] {
      const turns = [...this.root.querySelectorAll<HTMLElement>(SELECTORS.assistantTurn)]
        .filter((turn) => isAssistantConversationTurn(
          [...turn.querySelectorAll<HTMLElement>("[data-message-author-role]")]
            .map((node) => node.getAttribute("data-message-author-role") ?? "")
        ));
      const lastWithImages = turns.reverse().find((turn) => turn.querySelector(SELECTORS.images));
      if (lastWithImages) return normalizedSources(lastWithImages.querySelectorAll(SELECTORS.images));
      return [];
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

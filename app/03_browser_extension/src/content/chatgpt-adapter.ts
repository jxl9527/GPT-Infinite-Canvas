namespace GPTCanvasContent {
  const SELECTORS = Object.freeze({
    composer: "#prompt-textarea, textarea[data-testid='prompt-textarea'], div[contenteditable='true'][data-lexical-editor='true'], [contenteditable='true'][role='textbox']",
    upload: "input[type='file'][accept*='image'], input[type='file']",
    attachmentRemove: "main button[aria-label^='Remove file'], main button[aria-label^='移除文件']",
    send: "button[data-testid='send-button'], button[aria-label*='Send'], button[aria-label*='发送']",
    stop: "button[data-testid='stop-button'], button[aria-label*='Stop'], button[aria-label*='停止']",
    assistantTurn: "section[data-testid^='conversation-turn-'], article[data-testid^='conversation-turn-']",
    assistantComplete: "button[data-testid='copy-turn-action-button'], button[data-testid$='turn-action-button'], button[aria-label='Copy'], button[aria-label='复制']",
    images: "img[src]"
  });

  function isExplicitGeneratedImage(node: HTMLImageElement): boolean {
    if (/^(?:generated image|已生成图片)$/i.test((node.alt || "").trim())) return true;
    let current: Element | null = node;
    for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
      if (current.classList.contains("group/imagegen-image")) return true;
    }
    return false;
  }

  function normalizedSources(nodes: Iterable<Element>): string[] {
    const sources: string[] = [];
    for (const node of nodes) {
      if (!(node instanceof HTMLImageElement)) continue;
      const source = node.currentSrc || node.src || "";
      if (isCollectableGeneratedImage(
        source,
        node.naturalWidth,
        node.naturalHeight,
        isExplicitGeneratedImage(node)
      )) sources.push(source);
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
          // ChatGPT image-generation turns no longer always expose an explicit
          // data-message-author-role="assistant" node. User turns still expose
          // role="user", so exclude those instead of requiring the old marker.
          return isAssistantConversationTurn(roles);
        });
    }
    composer(): HTMLElement | null { return this.root.querySelector<HTMLElement>(SELECTORS.composer); }
    uploadInput(): HTMLInputElement | null { return this.root.querySelector<HTMLInputElement>(SELECTORS.upload); }
    attachmentCount(): number { return this.root.querySelectorAll(SELECTORS.attachmentRemove).length; }
    sendButton(): HTMLButtonElement | null { return this.root.querySelector<HTMLButtonElement>(SELECTORS.send); }
    isSendReady(): boolean { const button = this.sendButton(); return Boolean(button && !button.disabled); }
    isGenerating(): boolean { return Boolean(this.root.querySelector(SELECTORS.stop)); }
    isResponseComplete(): boolean {
      const turns = this.assistantTurns();
      const latestTurn = turns[turns.length - 1];
      return Boolean(latestTurn && !this.isGenerating() && latestTurn.querySelector(SELECTORS.assistantComplete));
    }

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

    submissionMarker(): string {
      const turns = [...this.root.querySelectorAll<HTMLElement>(SELECTORS.assistantTurn)];
      const latest = turns[turns.length - 1];
      return `${turns.length}:${latest?.getAttribute("data-testid") ?? ""}`;
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

    async waitForAttachmentCount(expectedCount: number, timeoutMs = 45_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (this.attachmentCount() === expectedCount) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`ChatGPT 附件确认超时：应为 ${expectedCount} 张，实际为 ${this.attachmentCount()} 张`);
    }

    async waitForSubmissionStart(previousMarker = "", timeoutMs = 45_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const composer = this.composer();
        const composerText = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
          ? composer.value
          : composer?.textContent ?? "";
        if (this.isGenerating()
          || !composerText.replace(/[\u200B-\u200D\u2060\uFEFF\s]/g, "")
          || (previousMarker && this.submissionMarker() !== previousMarker)) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("ChatGPT 未确认发送：输入框未清空、未进入生成且未出现新对话轮次，任务已暂停以避免误报和重复提交");
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

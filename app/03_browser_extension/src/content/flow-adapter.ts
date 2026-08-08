namespace GPTCanvasContent {
  const FLOW_PROJECT_PATH = "/tools/flow/project/";
  const FLOW_BINDING_PREFIX = "flow-project-binding:";
  const FLOW_COMPOSER_SELECTORS = [
    "textarea[placeholder*='创作']",
    "textarea[placeholder*='描述']",
    "textarea[placeholder*='希望']",
    "textarea[placeholder*='Create' i]",
    "textarea[placeholder*='Describe' i]",
    "textarea[placeholder*='Prompt' i]",
    "[contenteditable='true'][role='textbox']",
    "textarea"
  ].join(",");
  const FLOW_UPLOAD_SELECTOR = "input[type='file'][accept*='image'], input[type='file']";
  const FLOW_SEND_SELECTOR = [
    "button[aria-label*='生成']",
    "button[aria-label*='创作']",
    "button[aria-label*='发送']",
    "button[aria-label*='Generate' i]",
    "button[aria-label*='Create' i]",
    "button[aria-label*='Send' i]",
    "button[title*='生成']",
    "button[title*='Generate' i]",
    "button[title*='Create' i]"
  ].join(",");

  function visible(element: Element): boolean {
    const target = element as HTMLElement;
    const style = getComputedStyle(target);
    return style.display !== "none" && style.visibility !== "hidden" && target.getClientRects().length > 0;
  }

  function elementLabel(element: Element): string {
    return [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("data-tooltip"),
      element.textContent
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  function imageSource(image: HTMLImageElement): string {
    return image.currentSrc || image.src || "";
  }

  function usableFlowImage(image: HTMLImageElement): boolean {
    const source = imageSource(image);
    if (!source || /^data:image\/svg/i.test(source)) return false;
    const width = image.naturalWidth || image.width || Number(image.getAttribute("width")) || 0;
    const height = image.naturalHeight || image.height || Number(image.getAttribute("height")) || 0;
    return width >= 256 && height >= 256;
  }

  function deepQueryAll<T extends Element>(root: Document | ShadowRoot, selector: string): T[] {
    const matches = [...root.querySelectorAll<T>(selector)];
    for (const host of root.querySelectorAll<HTMLElement>("*")) {
      if (host.shadowRoot) matches.push(...deepQueryAll<T>(host.shadowRoot, selector));
    }
    return matches;
  }

  function backgroundImageSources(root: Document | ShadowRoot): string[] {
    const sources: string[] = [];
    for (const element of deepQueryAll<HTMLElement>(root, "[style*='background-image']")) {
      const match = element.style.backgroundImage.match(/url\((['"]?)(.*?)\1\)/i);
      if (match?.[2] && element.clientWidth >= 256 && element.clientHeight >= 256) sources.push(match[2]);
    }
    return sources;
  }

  export class FlowAdapter implements GenerationPageAdapter {
    readonly provider = "google-flow" as const;
    readonly label = "Google Flow";

    constructor(readonly root: Document) {}

    async preparePage(context: AdapterTaskContext): Promise<void> {
      const localProject = context.localProject;
      if (!localProject) throw new Error("Google Flow 任务缺少本地项目标识");
      const key = `${FLOW_BINDING_PREFIX}${localProject.id}`;
      const pendingKey = `${key}:pending`;
      const stored = await chrome.storage.local.get([key, pendingKey]) as Record<string, unknown>;
      const binding = stored[key] as { url?: unknown } | undefined;
      const mappedUrl = typeof binding?.url === "string" && binding.url.includes(FLOW_PROJECT_PATH)
        ? binding.url
        : undefined;
      const pendingCreation = stored[pendingKey] === true;
      const created = await this.enterWorkspaceOrProject(localProject, mappedUrl, pendingCreation, key, pendingKey);
      if (created) await this.tryRenameProject(localProject.name);
      if (location.pathname.includes(FLOW_PROJECT_PATH)) {
        await chrome.storage.local.set({
          [key]: {
            url: location.href,
            localProjectName: localProject.name,
            boundAt: new Date().toISOString()
          }
        });
        await chrome.storage.local.remove(pendingKey);
      }
      const imageMode = [...this.root.querySelectorAll<HTMLButtonElement>("button,[role='tab']")]
        .find((button) => /^(图片|image)$/i.test(elementLabel(button)) && visible(button));
      if (imageMode && imageMode.getAttribute("aria-selected") !== "true" && imageMode.dataset.state !== "active") {
        imageMode.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (context.outputCount) {
        await this.waitForComposer();
        await this.selectOutputCount(context.outputCount, 30_000);
      }
    }

    private outputCountButton(count: 1 | 2 | 3 | 4): HTMLButtonElement | null {
      return [...this.root.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => visible(button) && new RegExp(`^x${count}$`, "i").test(elementLabel(button))) ?? null;
    }

    private outputCountSummary(): HTMLButtonElement | null {
      return [...this.root.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => visible(button) && /nano banana/i.test(elementLabel(button)) && /x[1-4]\s*$/i.test(elementLabel(button))) ?? null;
    }

    private async selectOutputCount(count: 1 | 2 | 3 | 4, timeoutMs = 10_000): Promise<void> {
      const selectedPattern = new RegExp(`x${count}\\s*$`, "i");
      const deadline = Date.now() + timeoutMs;
      let target: HTMLButtonElement | null = null;
      let settingsOpened = false;
      while (Date.now() < deadline) {
        const current = this.outputCountSummary();
        if (current && selectedPattern.test(elementLabel(current))) return;
        target = this.outputCountButton(count);
        if (target) break;
        if (!settingsOpened) {
          const settings = current ?? [...this.root.querySelectorAll<HTMLButtonElement>("button")]
            .find((button) => visible(button) && /nano banana/i.test(elementLabel(button)));
          if (settings) {
            settings.click();
            settingsOpened = true;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!target) {
        const nanoButtons = [...this.root.querySelectorAll<HTMLButtonElement>("button")]
          .filter((button) => visible(button) && /banana/i.test(elementLabel(button)))
          .map(elementLabel);
        throw new Error(
          `Google Flow 在 ${Math.round(timeoutMs / 1_000)} 秒内未显示 x${count} 输出数量选项`
          + (nanoButtons.length ? `（已识别：${nanoButtons.join(" / ")}）` : "（未识别到 Nano Banana 控件）")
        );
      }
      target.click();
      const verifyDeadline = Date.now() + 3_000;
      while (Date.now() < verifyDeadline) {
        const summary = this.outputCountSummary();
        if (
          (summary && selectedPattern.test(elementLabel(summary)))
          || target.getAttribute("aria-checked") === "true"
          || target.getAttribute("aria-pressed") === "true"
          || target.dataset.state === "active"
        ) return;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new Error(`Google Flow 未确认 x${count} 输出数量`);
    }

    private projectLink(): HTMLAnchorElement | null {
      return [...this.root.querySelectorAll<HTMLAnchorElement>("a[href]")]
        .find((link) => link.href.includes(FLOW_PROJECT_PATH)) ?? null;
    }

    private workspaceLaunchButton(): HTMLButtonElement | null {
      return [...this.root.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => visible(button) && isFlowWorkspaceLaunchLabel(elementLabel(button))) ?? null;
    }

    private newProjectButton(): HTMLButtonElement | null {
      return [...this.root.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => visible(button) && /新建项目|new project/i.test(elementLabel(button))) ?? null;
    }

    private backToProjectsButton(): HTMLButtonElement | null {
      return [...this.root.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => visible(button) && /^(返回|back|arrow_back)$/i.test(elementLabel(button))) ?? null;
    }

    private missingProjectPage(): boolean {
      const text = [...this.root.querySelectorAll<HTMLElement>("h1,h2,h3,[role='alert']")]
        .filter(visible)
        .map(elementLabel)
        .join(" ");
      const returnButton = [...this.root.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => visible(button) && /返回项目|back to projects/i.test(elementLabel(button)));
      return Boolean(returnButton && /出了点问题|something went wrong/i.test(text));
    }

    private async enterWorkspaceOrProject(
      localProject: { id: string; name: string },
      mappedUrl: string | undefined,
      pendingCreation: boolean,
      bindingKey: string,
      pendingKey: string,
      timeoutMs = 90_000
    ): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      let launchClicked = false;
      let projectNavigationStarted = false;
      let mappedProjectMissing = false;
      let newProjectClicked = false;
      let returnedToProjects = false;
      while (Date.now() < deadline) {
        if (mappedUrl && this.missingProjectPage()) {
          mappedProjectMissing = true;
          mappedUrl = undefined;
          await chrome.storage.local.remove([bindingKey, pendingKey]);
          location.assign("https://labs.google/fx/zh/tools/flow");
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        if (mappedUrl && !projectNavigationStarted && location.href !== mappedUrl) {
          projectNavigationStarted = true;
          location.assign(mappedUrl);
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        if (
          mappedUrl
          && projectNavigationStarted
          && !location.pathname.includes(FLOW_PROJECT_PATH)
          && this.newProjectButton()
        ) {
          mappedProjectMissing = true;
          mappedUrl = undefined;
          await chrome.storage.local.remove([bindingKey, pendingKey]);
        }
        if (location.pathname.includes(FLOW_PROJECT_PATH) && this.composer()) {
          return pendingCreation || newProjectClicked;
        }
        if (this.composer()) {
          if (mappedUrl || pendingCreation || newProjectClicked) return pendingCreation || newProjectClicked;
          if (!returnedToProjects) {
            const back = this.backToProjectsButton();
            if (back) {
              returnedToProjects = true;
              back.click();
              await new Promise((resolve) => setTimeout(resolve, 500));
              continue;
            }
          }
        }
        if ((!mappedUrl || mappedProjectMissing) && !newProjectClicked) {
          const createProject = this.newProjectButton();
          if (createProject) {
            await chrome.storage.local.set({ [pendingKey]: true });
            newProjectClicked = true;
            createProject.click();
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
        }
        if (!launchClicked) {
          const launch = this.workspaceLaunchButton();
          if (launch) {
            launchClicked = true;
            launch.click();
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error(
        `未能为本地项目“${localProject.name}”${mappedUrl ? "打开已绑定" : "创建独立"}的 Google Flow 项目`
      );
    }

    private async tryRenameProject(name: string): Promise<void> {
      const edit = [...this.root.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => visible(button) && /^(编辑|重命名|edit|rename)$/i.test(elementLabel(button)));
      if (!edit) return;
      edit.click();
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const input = [...this.root.querySelectorAll<HTMLInputElement>("input")]
          .find((candidate) => visible(candidate) && !/搜索|search/i.test(candidate.placeholder));
        if (input) {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, name.slice(0, 40));
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
          input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    composer(): HTMLElement | null {
      return [...this.root.querySelectorAll<HTMLElement>(FLOW_COMPOSER_SELECTORS)].find(visible) ?? null;
    }

    uploadInput(): HTMLInputElement | null {
      return this.root.querySelector<HTMLInputElement>(FLOW_UPLOAD_SELECTOR);
    }

    sendButton(): HTMLButtonElement | null {
      const explicit = [...this.root.querySelectorAll<HTMLButtonElement>(FLOW_SEND_SELECTOR)]
        .find((button) => visible(button));
      if (explicit) return explicit;
      const composer = this.composer();
      if (!composer) return null;
      const labeled = [...this.root.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => visible(button) && /arrow_forward.*创建|创建.*arrow_forward|生成|generate|send/i.test(elementLabel(button)));
      if (labeled) return labeled;
      let container: HTMLElement | null = composer.parentElement;
      for (let depth = 0; container && depth < 6; depth += 1, container = container.parentElement) {
        const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")]
          .filter((button) => visible(button) && button.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_PRECEDING);
        const candidate = buttons.reverse().find((button) => {
          const label = elementLabel(button);
          return !/^(图片|视频|image|video|\+)$|添加|上传|比例|ratio|banana/i.test(label);
        });
        if (candidate) return candidate;
      }
      return null;
    }

    isSendReady(): boolean {
      const button = this.sendButton();
      return Boolean(button && !button.disabled && button.getAttribute("aria-disabled") !== "true");
    }

    isGenerating(): boolean {
      const progress = [...this.root.querySelectorAll<HTMLElement>(
        "[role='progressbar'],[aria-busy='true'],button[aria-label*='停止'],button[aria-label*='取消'],button[aria-label*='Stop' i],button[aria-label*='Cancel' i]"
      )].some(visible);
      return progress;
    }

    generationFailureReason(): string | null {
      const failure = deepQueryAll<HTMLElement>(this.root, "button,[role='alert'],article")
        .find((element) => visible(element) && /我们发现了一些异常活动|unusual activity/i.test(elementLabel(element)));
      return failure ? "Google Flow 生成失败：账号侧检测到异常活动；已停止自动重试" : null;
    }

    async waitForComposer(timeoutMs = 120_000): Promise<HTMLElement> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const target = this.composer();
        if (target) return target;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("等待 Google Flow 图片输入区超时；请检查登录、项目页面或网页验证");
    }

    async waitForUploadInput(timeoutMs = 15_000): Promise<HTMLInputElement> {
      const existing = this.uploadInput();
      if (existing) return existing;
      const addButton = [...this.root.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => visible(button) && /上传媒体|上传的内容|upload media|uploaded content/i.test(elementLabel(button)))
        ?? [...this.root.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => visible(button) && /^(添加|\+|add)$/i.test(elementLabel(button)));
      addButton?.click();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const input = this.uploadInput();
        if (input) return input;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("未找到 Google Flow 图片附件入口；请手动点“+”后重试");
    }

    async tryReuseAttachment(remoteName: string): Promise<boolean> {
      const addToPromptPattern = /添加到提示|add to prompt/i;
      let addToPrompt = [...this.root.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => visible(button) && addToPromptPattern.test(elementLabel(button)));
      if (!addToPrompt) {
        const plus = [...this.root.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => visible(button) && /add_2.*(?:创建|create)|(?:创建|create).*add_2/i.test(elementLabel(button)))
          ?? [...this.root.querySelectorAll<HTMLButtonElement>("button")]
            .find((button) => visible(button) && /^(添加|\+|add)$/i.test(elementLabel(button)));
        plus?.click();
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          addToPrompt = [...this.root.querySelectorAll<HTMLButtonElement>("button")]
            .find((button) => visible(button) && addToPromptPattern.test(elementLabel(button)));
          if (addToPrompt) break;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      if (!addToPrompt) return false;
      const dialog = [...this.root.querySelectorAll<HTMLElement>("[role='dialog']")].find(visible);
      if (!dialog) return false;
      const assetDeadline = Date.now() + 10_000;
      let assetControl: HTMLElement | null = null;
      while (Date.now() < assetDeadline) {
        const matches = [...dialog.querySelectorAll<HTMLElement>("[role='option'],button,[role='listitem']")]
          .filter((element) => {
            if (!visible(element)) return false;
            const image = element.querySelector<HTMLImageElement>("img");
            return image?.alt === remoteName || (element.textContent ?? "").includes(remoteName);
          });
        assetControl = matches.find((element) =>
          element.getAttribute("aria-selected") === "true"
          || element.getAttribute("aria-checked") === "true"
          || /selected|checked|active/.test(element.dataset.state ?? "")
        ) ?? matches[0] ?? null;
        if (assetControl) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!assetControl) return false;
      if (
        assetControl?.getAttribute("aria-selected") !== "true"
        && assetControl?.getAttribute("aria-checked") !== "true"
        && !/selected|checked|active/.test(assetControl?.dataset.state ?? "")
      ) {
        assetControl?.click();
      }
      const confirmDeadline = Date.now() + 3_000;
      let confirm: HTMLButtonElement | null = null;
      while (Date.now() < confirmDeadline) {
        confirm = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => visible(button) && addToPromptPattern.test(elementLabel(button))) ?? null;
        if (confirm && !confirm.disabled && confirm.getAttribute("aria-disabled") !== "true") break;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (!confirm || confirm.disabled || confirm.getAttribute("aria-disabled") === "true") return false;
      confirm.click();
      const attachedDeadline = Date.now() + 3_000;
      while (Date.now() < attachedDeadline) {
        if (!visible(dialog)) return true;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return !visible(dialog);
    }

    async waitUntilSendReady(timeoutMs = 90_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (this.isSendReady()) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const button = this.sendButton();
      const state = button
        ? `disabled=${button.disabled}，aria-disabled=${button.getAttribute("aria-disabled") ?? "未设置"}`
        : "未识别到生成按钮";
      throw new Error(`Google Flow 生成按钮在 ${Math.round(timeoutMs / 1_000)} 秒内未就绪（${state}）`);
    }

    collectGeneratedImages(): string[] {
      const sources = deepQueryAll<HTMLImageElement>(this.root, "img[src]")
        .filter(usableFlowImage)
        .map(imageSource);
      return [...new Set([...sources, ...backgroundImageSources(this.root)].filter(Boolean))];
    }
  }
}

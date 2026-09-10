import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  ProtocolError,
  SCHEMA_VERSION,
  assertGenerationTask,
  canTransition,
  isTerminalStatus,
  responseModeOf,
  type CreateTaskInput,
  type EventActor,
  type GenerationResult,
  type GenerationTextResult,
  type GenerationStatus,
  type GenerationTask,
  type HandoffRecord,
  type TaskAttachment,
  type TaskEvent
} from "@gpt-canvas/shared";

function clone<T>(value: T): T { return structuredClone(value); }

function taskId(now: Date): `task_${string}` {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `task_${date}_${randomUUID().slice(0, 8)}`;
}

function event(status: GenerationStatus, by: EventActor, at: string, note?: string): TaskEvent {
  return { id: randomUUID(), at, status, by, ...(note ? { note: note.slice(0, 1_000) } : {}) };
}

export class TaskStore {
  readonly projectRoot: string;
  readonly tasksRoot: string;
  readonly runsRoot: string;
  private readonly tasks = new Map<string, GenerationTask>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.tasksRoot = join(projectRoot, "tasks");
    this.runsRoot = join(projectRoot, "runs");
  }

  async init(): Promise<void> {
    await mkdir(this.tasksRoot, { recursive: true });
    await mkdir(this.runsRoot, { recursive: true });
    const entries = await readdir(this.tasksRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(this.tasksRoot, entry.name, "task.json");
      let parsed: unknown;
      try { parsed = JSON.parse(await readFile(path, "utf8")); }
      catch { throw new ProtocolError("INTERNAL_ERROR", `无法恢复任务数据：${entry.name}`); }
      assertGenerationTask(parsed);
      this.tasks.set(parsed.id, parsed);
    }
  }

  list(): GenerationTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone);
  }

  get(id: string): GenerationTask | undefined {
    const task = this.tasks.get(id);
    return task ? clone(task) : undefined;
  }

  getActive(): GenerationTask | undefined {
    const task = [...this.tasks.values()].find((candidate) => !isTerminalStatus(candidate.status));
    return task ? clone(task) : undefined;
  }

  async create(input: CreateTaskInput, attachments: TaskAttachment[]): Promise<GenerationTask> {
    return this.exclusive(async () => {
      const active = this.activeInternal();
      if (active) throw new ProtocolError("TASK_LOCKED", `当前任务 ${active.id} 尚未结束`);
      if (attachments.length !== input.attachments.length) {
        throw new ProtocolError("INVALID_ATTACHMENT", "附件解析结果与任务输入不一致");
      }
      const now = new Date(); const at = now.toISOString(); const queued = event("queued", "service", at, "任务已创建");
      const task: GenerationTask = {
        schemaVersion: SCHEMA_VERSION,
        id: taskId(now),
        idempotencyKey: randomUUID(),
        taskType: input.taskType,
        responseMode: input.responseMode ?? "image",
        target: clone(input.target),
        prompt: input.prompt,
        attachments: clone(attachments),
        status: "queued",
        createdAt: at,
        updatedAt: at,
        events: [queued],
        results: []
      };
      this.tasks.set(task.id, task);
      await this.persist(task, queued);
      return clone(task);
    });
  }

  async claim(id: string, by: EventActor = "extension"): Promise<GenerationTask> {
    return this.exclusive(async () => {
      const task = this.requiredInternal(id);
      const active = this.activeInternal();
      if (active && active.id !== id) throw new ProtocolError("TASK_LOCKED", `已有活动任务 ${active.id}`);
      if (task.status === "queued") return clone(await this.transitionInternal(task, "opening-chat", by, "扩展已领取任务"));
      if (!isTerminalStatus(task.status)) return clone(task);
      throw new ProtocolError("INVALID_TRANSITION", `终态任务 ${id} 不可领取`);
    });
  }

  async transition(id: string, next: GenerationStatus, by: EventActor, note?: string): Promise<GenerationTask> {
    return this.exclusive(async () => clone(await this.transitionInternal(this.requiredInternal(id), next, by, note)));
  }

  async handoff(id: string, reason: string, completedSteps: GenerationStatus[], by: EventActor = "extension"): Promise<GenerationTask> {
    return this.exclusive(async () => {
      const task = this.requiredInternal(id);
      if (isTerminalStatus(task.status)) throw new ProtocolError("INVALID_TRANSITION", "终态任务不可进入人工接管");
      const cleanReason = reason.trim().slice(0, 1_000);
      if (!cleanReason) throw new ProtocolError("INVALID_INPUT", "人工接管原因不能为空");
      const handoff: HandoffRecord = { at: new Date().toISOString(), by, reason: cleanReason, completedSteps: [...completedSteps] };
      task.handoff = handoff;
      if (task.status === "needs-user") { await this.persist(task); return clone(task); }
      return clone(await this.transitionInternal(task, "needs-user", by, cleanReason));
    });
  }

  async addResult(id: string, result: GenerationResult): Promise<{ result: GenerationResult; deduplicated: boolean }> {
    return this.exclusive(async () => {
      const task = this.requiredInternal(id);
      if (task.status !== "collecting") throw new ProtocolError("RESULT_STATE_REJECTED", "只有 collecting 状态可以写入结果");
      const existing = task.results.find((candidate) => candidate.sha256 === result.sha256);
      if (existing) return { result: clone(existing), deduplicated: true };
      task.results.push(clone(result)); task.updatedAt = new Date().toISOString();
      await this.persist(task);
      return { result: clone(result), deduplicated: false };
    });
  }

  async addTextResult(id: string, result: GenerationTextResult): Promise<{ result: GenerationTextResult; deduplicated: boolean }> {
    return this.exclusive(async () => {
      const task = this.requiredInternal(id);
      if (task.status !== "collecting") throw new ProtocolError("RESULT_STATE_REJECTED", "只有 collecting 状态可以写入文字结果");
      if (task.textResult) return { result: clone(task.textResult), deduplicated: true };
      task.textResult = clone(result); task.updatedAt = new Date().toISOString();
      await this.persist(task);
      return { result: clone(result), deduplicated: false };
    });
  }

  async complete(id: string, by: EventActor = "extension"): Promise<GenerationTask> {
    return this.exclusive(async () => {
      const task = this.requiredInternal(id);
      if (task.status !== "collecting" && task.status !== "returning") {
        throw new ProtocolError("RESULT_STATE_REJECTED", "只有 collecting 或 returning 状态可以完成任务");
      }
      const responseMode = responseModeOf(task);
      const hasImage = task.results.length > 0;
      const hasText = Boolean(task.textResult);
      if (responseMode === "image" && !hasImage) throw new ProtocolError("RECOVERY_REQUIRED", "没有本地图片结果，不能完成任务");
      if (responseMode === "text" && !hasText) throw new ProtocolError("RECOVERY_REQUIRED", "没有本地文字结果，不能完成任务");
      if (responseMode === "image-or-text" && !hasImage && !hasText) {
        throw new ProtocolError("RECOVERY_REQUIRED", "没有本地图片或文字结果，不能完成任务");
      }
      await this.verifyResultFiles(task);
      return clone(await this.transitionInternal(task, "completed", by, hasImage ? "图片结果已回收至本地任务目录" : "文字结论已回收至本地任务目录"));
    });
  }

  private activeInternal(): GenerationTask | undefined {
    return [...this.tasks.values()].find((candidate) => !isTerminalStatus(candidate.status));
  }

  private requiredInternal(id: string): GenerationTask {
    const task = this.tasks.get(id);
    if (!task) throw new ProtocolError("TASK_NOT_FOUND", `任务不存在：${id}`);
    return task;
  }

  private async transitionInternal(
    task: GenerationTask,
    next: GenerationStatus,
    by: EventActor,
    note?: string
  ): Promise<GenerationTask> {
    if (task.status === next) return task;
    if (next === "submitted" && task.submittedAt) throw new ProtocolError("ALREADY_SUBMITTED", "任务已经提交过");
    if (task.status === "ready-to-submit" && next === "uploading" && task.submittedAt) {
      throw new ProtocolError("ALREADY_SUBMITTED", "已提交任务不得回退到附件上传阶段");
    }
    if (!canTransition(task.status, next)) {
      throw new ProtocolError("INVALID_TRANSITION", `不允许从 ${task.status} 变更为 ${next}`);
    }
    const active = this.activeInternal();
    if (!isTerminalStatus(next) && active && active.id !== task.id) {
      throw new ProtocolError("TASK_LOCKED", `已有活动任务 ${active.id}`);
    }
    const at = new Date().toISOString(); const nextEvent = event(next, by, at, note);
    task.status = next; task.updatedAt = at; task.events.push(nextEvent);
    if (next === "submitted") task.submittedAt = at;
    await this.persist(task, nextEvent);
    return task;
  }

  private async persist(task: GenerationTask, appendedEvent?: TaskEvent): Promise<void> {
    const taskDir = join(this.tasksRoot, task.id); const runDir = join(this.runsRoot, task.id);
    await mkdir(taskDir, { recursive: true }); await mkdir(runDir, { recursive: true });
    const destination = join(taskDir, "task.json"); const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(task, null, 2)}\n`, "utf8"); await rename(temporary, destination);
    if (appendedEvent) await appendFile(join(runDir, "events.jsonl"), `${JSON.stringify(appendedEvent)}\n`, "utf8");
  }

  private async verifyResultFiles(task: GenerationTask): Promise<void> {
    const resultRoot = resolve(this.projectRoot, "runs", task.id, "results");
    for (const result of task.results) {
      const absolute = resolve(this.projectRoot, result.relativePath);
      if (!(absolute === resultRoot || absolute.startsWith(`${resultRoot}${sep}`))) {
        throw new ProtocolError("RECOVERY_REQUIRED", "结果路径不在当前任务目录内");
      }
      let file;
      try { file = await stat(absolute); }
      catch { throw new ProtocolError("RECOVERY_REQUIRED", `结果文件缺失：${result.filename}`); }
      if (!file.isFile() || file.size !== result.bytes) {
        throw new ProtocolError("RECOVERY_REQUIRED", `结果文件大小不匹配：${result.filename}`);
      }
      const sha256 = createHash("sha256").update(await readFile(absolute)).digest("hex");
      if (sha256 !== result.sha256) throw new ProtocolError("RECOVERY_REQUIRED", `结果文件哈希不匹配：${result.filename}`);
    }
    if (task.textResult) {
      const absolute = resolve(this.projectRoot, task.textResult.relativePath);
      if (!(absolute === resultRoot || absolute.startsWith(`${resultRoot}${sep}`))) {
        throw new ProtocolError("RECOVERY_REQUIRED", "文字结果路径不在当前任务目录内");
      }
      const file = await stat(absolute).catch(() => null);
      if (!file?.isFile() || file.size !== task.textResult.bytes) {
        throw new ProtocolError("RECOVERY_REQUIRED", "文字结果文件缺失或大小不匹配");
      }
      const sha256 = createHash("sha256").update(await readFile(absolute)).digest("hex");
      if (sha256 !== task.textResult.sha256) throw new ProtocolError("RECOVERY_REQUIRED", "文字结果文件哈希不匹配");
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

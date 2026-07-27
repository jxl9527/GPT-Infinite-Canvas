import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SCHEMA_VERSION, type ErrorCode, type GenerationStatus } from "@gpt-canvas/shared";
import type { TaskStore } from "./task-store.js";

export interface DiagnosticInput {
  level?: "info" | "warn" | "error";
  event: string;
  taskId?: string;
  status?: GenerationStatus;
  errorCode?: ErrorCode;
  method?: string;
  path?: string;
  httpStatus?: number;
  durationMs?: number;
  message?: string;
}

export interface DiagnosticExport {
  filename: string;
  relativePath: string;
  bytes: number;
  sha256: string;
}

function redactText(value: string): string {
  return value
    .replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(/\b(?:bearer\s+)?[A-Za-z0-9_-]{32,}\b/gi, "[SECRET]")
    .slice(0, 1_000);
}

export class DiagnosticLogger {
  readonly projectRoot: string;
  readonly logsRoot: string;
  readonly logPath: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.logsRoot = join(projectRoot, "logs");
    this.logPath = join(this.logsRoot, "bridge.jsonl");
  }

  async init(): Promise<void> { await mkdir(this.logsRoot, { recursive: true }); }

  async log(input: DiagnosticInput): Promise<void> {
    await this.init();
    const record = {
      at: new Date().toISOString(),
      level: input.level ?? "info",
      event: redactText(input.event),
      ...(input.taskId ? { taskId: redactText(input.taskId) } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.method ? { method: input.method.slice(0, 12) } : {}),
      ...(input.path ? { path: input.path.split("?", 1)[0]?.slice(0, 500) } : {}),
      ...(typeof input.httpStatus === "number" ? { httpStatus: input.httpStatus } : {}),
      ...(typeof input.durationMs === "number" ? { durationMs: Math.max(0, Math.round(input.durationMs)) } : {}),
      ...(input.message ? { message: redactText(input.message) } : {})
    };
    await appendFile(this.logPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  async exportBundle(store: TaskStore): Promise<DiagnosticExport> {
    await this.init();
    let recentRecords: unknown[] = [];
    try {
      const lines = (await readFile(this.logPath, "utf8")).split(/\r?\n/).filter(Boolean).slice(-200);
      recentRecords = lines.map((line) => { try { return JSON.parse(line); } catch { return { event: "invalid-log-line" }; } });
    } catch { /* no log file yet */ }

    const payload = {
      schemaVersion: SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      service: { name: "@gpt-canvas/bridge-service", version: "0.2.0", host: "127.0.0.1" },
      tasks: store.list().map((task) => ({
        id: task.id,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        submittedAt: task.submittedAt ?? null,
        attachmentCount: task.attachments.length,
        resultCount: task.results.length,
        eventStatuses: task.events.map((item) => item.status),
        hasHandoff: Boolean(task.handoff)
      })),
      recentRecords
    };
    const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const exportRoot = join(this.logsRoot, "diagnostics"); await mkdir(exportRoot, { recursive: true });
    const filename = `diagnostic_${new Date().toISOString().replaceAll(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}.json`;
    const destination = join(exportRoot, filename); const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { flag: "wx" }); await rename(temporary, destination);
    return {
      filename,
      relativePath: `logs/diagnostics/${filename}`,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    };
  }
}

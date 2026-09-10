import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  MAX_VIEWPOINT_CONCLUSION_LENGTH,
  MAX_VIEWPOINT_NAME_LENGTH,
  ProtocolError,
  WORKFLOW_RUN_CHECKPOINTS,
  WORKFLOW_RUNNER_KINDS,
  type CanvasImageAsset
} from "@gpt-canvas/shared";

type JsonObject = Record<string, unknown>;
const MAX_PROJECT_SNAPSHOTS = 120;
const MAX_CONFLICT_DRAFTS = 20;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new ProtocolError("INVALID_INPUT", `${field} 必须是数组`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ProtocolError("INVALID_INPUT", `${field} 无效`);
  return value;
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum) {
    throw new ProtocolError("INVALID_INPUT", `${field} 无效`);
  }
  return value;
}

function optionalRecord(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function validateProject(value: unknown): JsonObject {
  if (!isRecord(value) || (value.schemaVersion !== "1.0" && value.schemaVersion !== "2.0")) {
    throw new ProtocolError("RECOVERY_REQUIRED", "画布项目 schemaVersion 无效");
  }
  const isV3 = value.schemaVersion === "2.0";
  if (!/^project_[0-9a-f-]{36}$/.test(requiredString(value.projectId, "projectId"))) {
    throw new ProtocolError("INVALID_INPUT", "projectId 无效");
  }
  requiredString(value.title, "title");
  if (!Number.isInteger(value.revision) || (value.revision as number) < 0) {
    throw new ProtocolError("INVALID_INPUT", "revision 无效");
  }
  if (!isRecord(value.canvas) || !isRecord(value.canvas.viewport)) {
    throw new ProtocolError("INVALID_INPUT", "canvas 或 viewport 无效");
  }
  const viewport = value.canvas.viewport;
  if (
    !Number.isFinite(viewport.x)
    || !Number.isFinite(viewport.y)
    || !Number.isFinite(viewport.scale)
    || (viewport.scale as number) <= 0
    || (viewport.scale as number) > 16
  ) {
    throw new ProtocolError("INVALID_INPUT", "viewport 数值无效");
  }
  const nodes = requiredArray(value.canvas.nodes, "canvas.nodes");
  const assets = requiredArray(value.assets, "assets");
  const versions = requiredArray(value.versions, "versions");
  const taskLinks = requiredArray(value.taskLinks, "taskLinks");
  const assetIds = new Set<string>();
  for (const asset of assets) {
    if (!isRecord(asset) || typeof asset.id !== "string" || !asset.id.startsWith("asset_")) {
      throw new ProtocolError("INVALID_INPUT", "图片资产记录无效");
    }
    if (assetIds.has(asset.id)) throw new ProtocolError("INVALID_INPUT", `图片资产重复：${asset.id}`);
    assetIds.add(asset.id);
  }
  const versionIds = new Set<string>();
  for (const version of versions) {
    if (
      !isRecord(version)
      || typeof version.id !== "string"
      || !version.id.startsWith("version_")
      || typeof version.assetId !== "string"
      || !assetIds.has(version.assetId)
    ) {
      throw new ProtocolError("RECOVERY_REQUIRED", "图片版本引用了不存在的资产");
    }
    if (versionIds.has(version.id)) throw new ProtocolError("INVALID_INPUT", `图片版本重复：${version.id}`);
    versionIds.add(version.id);
  }
  for (const version of versions) {
    if (isRecord(version) && version.parentVersionId !== null && !versionIds.has(String(version.parentVersionId))) {
      throw new ProtocolError("RECOVERY_REQUIRED", `父版本不存在：${String(version.parentVersionId)}`);
    }
  }
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (
      !isRecord(node)
      || typeof node.id !== "string"
      || !node.id.startsWith("node_")
      || !isRecord(node.payload)
    ) {
      throw new ProtocolError("INVALID_INPUT", "画布节点无效");
    }
    if (nodeIds.has(node.id)) throw new ProtocolError("INVALID_INPUT", `画布节点重复：${node.id}`);
    nodeIds.add(node.id);
    if (node.type === "image" && !versionIds.has(String(node.payload.imageVersionId))) {
      throw new ProtocolError("RECOVERY_REQUIRED", `图片节点引用了不存在的版本：${String(node.payload.imageVersionId)}`);
    }
  }
  for (const link of taskLinks) {
    if (!isRecord(link)) throw new ProtocolError("INVALID_INPUT", "taskLinks 记录无效");
    if (link.parentVersionId !== null && !versionIds.has(String(link.parentVersionId))) {
      throw new ProtocolError("RECOVERY_REQUIRED", "任务父版本不存在");
    }
    for (const resultVersionId of requiredArray(link.resultVersionIds, "taskLink.resultVersionIds")) {
      if (!versionIds.has(String(resultVersionId))) throw new ProtocolError("RECOVERY_REQUIRED", "任务结果版本不存在");
    }
  }
  if (value.workflow !== undefined) {
    if (!isRecord(value.workflow)) throw new ProtocolError("INVALID_INPUT", "workflow 无效");
    const viewpoints = requiredArray(value.workflow.viewpoints, "workflow.viewpoints");
    const handoffs = requiredArray(value.workflow.handoffs, "workflow.handoffs");
    const textCards = value.workflow.textCards === undefined
      ? []
      : requiredArray(value.workflow.textCards, "workflow.textCards");
    const viewpointIds = new Set<string>();
    const stages = new Set(isV3
      ? ["preflight", "scene-optimization", "final-glass", "completed"]
      : ["stage-1", "stage-2", "stage-3", "stage-4", "final"]);
    const statuses = new Set(["not-started", "in-progress", "locked", "rework", "blocked"]);
    const targets = new Set(isV3
      ? ["su", "d5", "gpt", "codex", "review"]
      : ["su", "d5", "gpt", "codex", "photoshop", "review"]);
    if (value.workflow.customGptUrl !== undefined) {
      const customGptUrl = boundedString(value.workflow.customGptUrl, "workflow.customGptUrl", 500);
      if (customGptUrl) {
        let parsed: URL;
        try { parsed = new URL(customGptUrl); }
        catch { throw new ProtocolError("INVALID_INPUT", "专属 GPT 地址无效"); }
        if (
          parsed.protocol !== "https:"
          || (parsed.hostname !== "chatgpt.com" && parsed.hostname !== "chat.openai.com")
          || !parsed.pathname.startsWith("/g/g-")
        ) {
          throw new ProtocolError("INVALID_INPUT", "专属 GPT 地址无效");
        }
      }
    }
    for (const viewpoint of viewpoints) {
      if (
        !isRecord(viewpoint)
        || typeof viewpoint.id !== "string"
        || !viewpoint.id.startsWith("viewpoint_")
        || viewpointIds.has(viewpoint.id)
        || !stages.has(String(viewpoint.stage))
        || !statuses.has(String(viewpoint.status))
        || (viewpoint.statusMode !== undefined && viewpoint.statusMode !== "auto" && viewpoint.statusMode !== "manual")
      ) {
        throw new ProtocolError("INVALID_INPUT", "视角状态卡无效");
      }
      viewpointIds.add(viewpoint.id);
      boundedString(viewpoint.name, "viewpoint.name", MAX_VIEWPOINT_NAME_LENGTH);
      boundedString(viewpoint.purpose, "viewpoint.purpose", 100);
      boundedString(viewpoint.d5Batch, "viewpoint.d5Batch", 20);
      boundedString(viewpoint.conclusion, "viewpoint.conclusion", MAX_VIEWPOINT_CONCLUSION_LENGTH);
      boundedString(viewpoint.nextAction, "viewpoint.nextAction", 600);
      requiredString(viewpoint.updatedAt, "viewpoint.updatedAt");
      for (const field of ["sourceVersionId", "selectedVersionId"] as const) {
        const versionId = viewpoint[field];
        if (versionId !== null && !versionIds.has(String(versionId))) {
          throw new ProtocolError("RECOVERY_REQUIRED", `视角状态卡引用了不存在的版本：${String(versionId)}`);
        }
      }
      if (isV3) {
        if (!isRecord(viewpoint.preflight) || !isRecord(viewpoint.sceneOptimization) || !isRecord(viewpoint.finalGlass) || !isRecord(viewpoint.export)) {
          throw new ProtocolError("RECOVERY_REQUIRED", "V3 视角缺少三阶段状态");
        }
        const versionFields = [
          viewpoint.preflight.d5ViewVersionId,
          viewpoint.preflight.suReferenceVersionId,
          viewpoint.sceneOptimization.structureBaseVersionId,
          viewpoint.sceneOptimization.styleReferenceVersionId,
          viewpoint.sceneOptimization.selectedVersionId,
          viewpoint.finalGlass.finalD5VersionId
        ];
        for (const versionId of versionFields) {
          if (versionId !== null && versionId !== undefined && !versionIds.has(String(versionId))) {
            throw new ProtocolError("RECOVERY_REQUIRED", `V3 视角引用了不存在的版本：${String(versionId)}`);
          }
        }
        for (const field of [
          viewpoint.sceneOptimization.candidateVersionIds,
          viewpoint.finalGlass.candidateVersionIds,
          viewpoint.finalGlass.selectedVersionIds,
          viewpoint.export.exportedVersionIds
        ]) {
          for (const versionId of requiredArray(field, "V3 viewpoint version ids")) {
            if (!versionIds.has(String(versionId))) {
              throw new ProtocolError("RECOVERY_REQUIRED", `V3 视角列表引用了不存在的版本：${String(versionId)}`);
            }
          }
        }
        if (!new Set(["pending", "completed", "not-run", "external"]).has(String(viewpoint.preflight.status))) {
          throw new ProtocolError("INVALID_INPUT", "前置阶段状态无效");
        }
        if (!new Set(["pending", "prompt-ready", "generated", "selected", "not-run"]).has(String(viewpoint.sceneOptimization.status))) {
          throw new ProtocolError("INVALID_INPUT", "优化阶段状态无效");
        }
        if (!new Set(["pending", "generated", "selected", "not-run"]).has(String(viewpoint.finalGlass.status))) {
          throw new ProtocolError("INVALID_INPUT", "最终阶段状态无效");
        }
        if (!new Set(["pending", "passed", "failed"]).has(String(viewpoint.finalGlass.validation))) {
          throw new ProtocolError("INVALID_INPUT", "玻璃深化验收状态无效");
        }
        if (!new Set(["pending", "partial", "completed"]).has(String(viewpoint.export.status))) {
          throw new ProtocolError("INVALID_INPUT", "导出状态无效");
        }
        const candidateReviews = viewpoint.candidateReviews === undefined
          ? []
          : requiredArray(viewpoint.candidateReviews, "viewpoint.candidateReviews");
        const reviewKeys = ["structure", "facade", "site", "material", "atmosphere"];
        for (const review of candidateReviews) {
          if (
            !isRecord(review)
            || !versionIds.has(String(review.versionId))
            || !new Set(["scene-optimization", "final-glass"]).has(String(review.stage))
            || !new Set(["pending", "approved", "rejected"]).has(String(review.decision))
            || !isRecord(review.checks)
          ) {
            throw new ProtocolError("INVALID_INPUT", "候选验收记录无效");
          }
          for (const key of reviewKeys) {
            if (!new Set(["pending", "passed", "failed"]).has(String(review.checks[key]))) {
              throw new ProtocolError("INVALID_INPUT", `候选验收项无效：${key}`);
            }
          }
          boundedString(review.note, "candidateReview.note", 1000);
          requiredString(review.updatedAt, "candidateReview.updatedAt");
        }
      }
    }
    if (value.workflow.activeViewpointId !== null && !viewpointIds.has(String(value.workflow.activeViewpointId))) {
      throw new ProtocolError("RECOVERY_REQUIRED", "当前视角状态卡不存在");
    }
    const textCardIds = new Set<string>();
    for (const card of textCards) {
      if (
        !isRecord(card)
        || typeof card.id !== "string"
        || !card.id.startsWith("text_card_")
        || textCardIds.has(card.id)
        || !new Set(["review", "prompt"]).has(String(card.kind))
      ) {
        throw new ProtocolError("INVALID_INPUT", "画布文字卡无效");
      }
      textCardIds.add(card.id);
      boundedString(card.title, "workflow.textCard.title", 120);
      boundedString(card.text, "workflow.textCard.text", 20_000);
      if (card.sourceVersionId !== null && !versionIds.has(String(card.sourceVersionId))) {
        throw new ProtocolError("RECOVERY_REQUIRED", "文字卡引用了不存在的版本");
      }
      if (![card.x, card.y, card.width, card.height].every(Number.isFinite)) {
        throw new ProtocolError("INVALID_INPUT", "文字卡位置或尺寸无效");
      }
      if ((card.width as number) < 240 || (card.height as number) < 160) {
        throw new ProtocolError("INVALID_INPUT", "文字卡尺寸过小");
      }
      requiredString(card.taskId, "workflow.textCard.taskId");
      requiredString(card.createdAt, "workflow.textCard.createdAt");
      requiredString(card.updatedAt, "workflow.textCard.updatedAt");
      if (card.idempotencyKey !== undefined) {
        const key = boundedString(card.idempotencyKey, "workflow.textCard.idempotencyKey", 500);
        if (!key) throw new ProtocolError("INVALID_INPUT", "文字卡幂等键无效");
      }
    }
    const handoffIds = new Set<string>();
    for (const handoff of handoffs) {
      if (
        !isRecord(handoff)
        || typeof handoff.id !== "string"
        || !handoff.id.startsWith("handoff_")
        || handoffIds.has(handoff.id)
        || !viewpointIds.has(String(handoff.viewpointId))
        || !stages.has(String(handoff.stage))
        || !statuses.has(String(handoff.status))
        || !targets.has(String(handoff.target))
      ) {
        throw new ProtocolError("INVALID_INPUT", "标准交接记录无效");
      }
      handoffIds.add(handoff.id);
      boundedString(handoff.viewpointName, "handoff.viewpointName", 40);
      boundedString(handoff.d5Batch, "handoff.d5Batch", 20);
      boundedString(handoff.conclusion, "handoff.conclusion", MAX_VIEWPOINT_CONCLUSION_LENGTH);
      boundedString(handoff.nextAction, "handoff.nextAction", 600);
      requiredString(handoff.createdAt, "handoff.createdAt");
      for (const field of ["sourceVersionId", "selectedVersionId"] as const) {
        const versionId = handoff[field];
        if (versionId !== null && !versionIds.has(String(versionId))) {
          throw new ProtocolError("RECOVERY_REQUIRED", `交接记录引用了不存在的版本：${String(versionId)}`);
        }
      }
    }
    if (value.workflow.batchRun !== undefined && value.workflow.batchRun !== null) {
      const batchRun = value.workflow.batchRun;
      if (
        !isRecord(batchRun)
        || typeof batchRun.id !== "string"
        || !batchRun.id.startsWith("batch_")
        || !new Set(["ready", "running", "paused", "completed"]).has(String(batchRun.status))
      ) {
        throw new ProtocolError("INVALID_INPUT", "批量任务记录无效");
      }
      boundedString(batchRun.prompt, "workflow.batchRun.prompt", 12_000);
      if (
        batchRun.promptMode !== undefined
        && batchRun.promptMode !== "reference-edit"
        && batchRun.promptMode !== "stage-only"
      ) {
        throw new ProtocolError("INVALID_INPUT", "批量任务提示词模式无效");
      }
      if (
        batchRun.workflowStage !== undefined
        && batchRun.workflowStage !== null
        && !stages.has(String(batchRun.workflowStage))
      ) {
        throw new ProtocolError("INVALID_INPUT", "批量任务阶段无效");
      }
      if (batchRun.targetChatUrl !== undefined && batchRun.targetChatUrl !== null) {
        const targetChatUrl = boundedString(batchRun.targetChatUrl, "workflow.batchRun.targetChatUrl", 500);
        if (targetChatUrl) {
          let parsed: URL;
          try { parsed = new URL(targetChatUrl); }
          catch { throw new ProtocolError("INVALID_INPUT", "批量任务专属 GPT 地址无效"); }
          if (
            parsed.protocol !== "https:"
            || (parsed.hostname !== "chatgpt.com" && parsed.hostname !== "chat.openai.com")
            || !parsed.pathname.startsWith("/g/g-")
          ) {
            throw new ProtocolError("INVALID_INPUT", "批量任务专属 GPT 地址无效");
          }
        }
      }
      requiredString(batchRun.createdAt, "workflow.batchRun.createdAt");
      requiredString(batchRun.updatedAt, "workflow.batchRun.updatedAt");
      if (
        batchRun.runner !== undefined
        && !(WORKFLOW_RUNNER_KINDS as readonly unknown[]).includes(batchRun.runner)
      ) {
        throw new ProtocolError("INVALID_INPUT", "批量任务执行器无效");
      }
      for (const field of ["codexThreadId", "leaseOwner", "leaseExpiresAt"] as const) {
        if (batchRun[field] !== undefined && batchRun[field] !== null) {
          boundedString(batchRun[field], `workflow.batchRun.${field}`, 500);
        }
      }
      if (batchRun.authorization !== undefined && batchRun.authorization !== null) {
        const authorization = batchRun.authorization;
        if (
          !isRecord(authorization)
          || typeof authorization.id !== "string"
          || !authorization.id.startsWith("authorization_")
          || !stages.has(String(authorization.stage))
          || authorization.stage === "completed"
          || !Number.isInteger(authorization.itemCount)
          || (authorization.itemCount as number) < 1
          || !Number.isInteger(authorization.maximumGenerations)
          || (authorization.maximumGenerations as number) < 0
          || authorization.allowManualFallback !== true && authorization.allowManualFallback !== false
          || authorization.stopOnStructureRisk !== true && authorization.stopOnStructureRisk !== false
        ) {
          throw new ProtocolError("INVALID_INPUT", "Codex 运行授权单无效");
        }
        if (authorization.sourceFolder !== null) {
          boundedString(authorization.sourceFolder, "workflow.batchRun.authorization.sourceFolder", 1_000);
        }
        requiredString(authorization.approvedAt, "workflow.batchRun.authorization.approvedAt");
      }
      if (
        batchRun.styleReferenceVersionId !== null
        && !versionIds.has(String(batchRun.styleReferenceVersionId))
      ) {
        throw new ProtocolError("RECOVERY_REQUIRED", "批量任务的风格参考版本不存在");
      }
      const batchItemIds = new Set<string>();
      for (const item of requiredArray(batchRun.items, "workflow.batchRun.items")) {
        if (
          !isRecord(item)
          || typeof item.id !== "string"
          || !item.id.startsWith("batch_item_")
          || batchItemIds.has(item.id)
          || !new Set(["queued", "running", "completed", "failed"]).has(String(item.status))
          || !versionIds.has(String(item.sourceVersionId))
        ) {
          throw new ProtocolError("INVALID_INPUT", "批量任务项目无效");
        }
        batchItemIds.add(item.id);
        boundedString(item.sourceName, "workflow.batchRun.item.sourceName", 260);
        boundedString(item.error, "workflow.batchRun.item.error", 1_000);
        if (
          item.runner !== undefined
          && !(WORKFLOW_RUNNER_KINDS as readonly unknown[]).includes(item.runner)
        ) {
          throw new ProtocolError("INVALID_INPUT", "批量任务项目执行器无效");
        }
        if (
          item.checkpoint !== undefined
          && item.checkpoint !== null
          && !(WORKFLOW_RUN_CHECKPOINTS as readonly unknown[]).includes(item.checkpoint)
        ) {
          throw new ProtocolError("INVALID_INPUT", "批量任务项目检查点无效");
        }
        if (item.idempotencyKey !== undefined) {
          const idempotencyKey = boundedString(item.idempotencyKey, "workflow.batchRun.item.idempotencyKey", 500);
          if (!idempotencyKey) throw new ProtocolError("INVALID_INPUT", "批量任务项目幂等键无效");
        }
        if (item.inputTextCardId !== undefined && item.inputTextCardId !== null) {
          const inputTextCardId = boundedString(item.inputTextCardId, "workflow.batchRun.item.inputTextCardId", 120);
          if (!inputTextCardId.startsWith("text_card_")) {
            throw new ProtocolError("INVALID_INPUT", "批量任务绑定提示词卡无效");
          }
        }
        if (item.inputPrompt !== undefined && item.inputPrompt !== null) {
          const inputPrompt = boundedString(item.inputPrompt, "workflow.batchRun.item.inputPrompt", 20_000);
          if (!inputPrompt) throw new ProtocolError("INVALID_INPUT", "批量任务绑定提示词无效");
        }
        if (
          item.attemptCount !== undefined
          && (!Number.isInteger(item.attemptCount) || (item.attemptCount as number) < 0)
        ) {
          throw new ProtocolError("INVALID_INPUT", "批量任务项目尝试次数无效");
        }
        for (const field of ["sourceHash", "promptHash"] as const) {
          if (item[field] !== undefined && item[field] !== null) {
            const hash = boundedString(item[field], `workflow.batchRun.item.${field}`, 64);
            if (!/^[a-f0-9]{64}$/.test(hash)) {
              throw new ProtocolError("INVALID_INPUT", `workflow.batchRun.item.${field} 无效`);
            }
          }
        }
        for (const resultVersionId of requiredArray(item.resultVersionIds, "workflow.batchRun.item.resultVersionIds")) {
          if (!versionIds.has(String(resultVersionId))) {
            throw new ProtocolError("RECOVERY_REQUIRED", "批量任务结果版本不存在");
          }
        }
      }
    }
  }
  return structuredClone(value);
}

export class CanvasProjectRepository {
  readonly projectRoot: string;
  readonly projectPath: string;
  readonly snapshotsRoot: string;
  readonly conflictsRoot: string;
  private current: JsonObject | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
    this.projectPath = join(this.projectRoot, "canvas", "project.json");
    this.snapshotsRoot = join(this.projectRoot, "canvas", "snapshots");
    this.conflictsRoot = join(this.projectRoot, "canvas", "conflicts");
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.projectPath), { recursive: true });
    await mkdir(this.snapshotsRoot, { recursive: true });
    await mkdir(this.conflictsRoot, { recursive: true });
    try {
      this.current = validateProject(JSON.parse(await readFile(this.projectPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  read(): JsonObject | null {
    return this.current ? structuredClone(this.current) : null;
  }

  async save(
    value: unknown,
    forceSnapshot = false
  ): Promise<{ project: JsonObject; snapshotRelativePath: string | null }> {
    return this.exclusive(async () => this.writeValidatedProject(validateProject(value), forceSnapshot));
  }

  async preserveConflictDraft(value: unknown): Promise<{
    currentProject: JsonObject;
    conflictRelativePath: string;
  }> {
    return this.exclusive(async () => {
      if (!this.current) throw new ProtocolError("TASK_LOCKED", "当前画布项目尚未建立");
      const draft = validateProject(value);
      if (draft.projectId !== this.current.projectId) {
        throw new ProtocolError("INVALID_INPUT", "冲突草稿不属于当前项目");
      }
      const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
      const revision = Number(draft.revision);
      const filename = `conflict_rev${String(revision).padStart(6, "0")}_${stamp}_${randomUUID().slice(0, 8)}.json`;
      const targetPath = join(this.conflictsRoot, filename);
      await writeFile(targetPath, `${JSON.stringify(draft, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await this.pruneConflictDrafts();
      return {
        currentProject: structuredClone(this.current),
        conflictRelativePath: `canvas/conflicts/${filename}`
      };
    });
  }

  async createCodexRun(value: unknown): Promise<{ project: JsonObject; run: JsonObject; snapshotRelativePath: string | null; deduplicated: boolean }> {
    return this.exclusive(async () => {
      if (!this.current) throw new ProtocolError("TASK_LOCKED", "当前画布项目尚未建立");
      if (!isRecord(value) || value.confirmed !== true) {
        throw new ProtocolError("INVALID_INPUT", "创建 Codex 批次前必须确认运行授权单");
      }
      const authorizationId = requiredString(value.authorizationId, "authorizationId");
      if (!/^authorization_[0-9a-z_-]{8,120}$/i.test(authorizationId)) {
        throw new ProtocolError("INVALID_INPUT", "authorizationId 无效");
      }
      const currentWorkflow = optionalRecord(this.current.workflow);
      const currentBatch = optionalRecord(currentWorkflow.batchRun);
      if (optionalRecord(currentBatch.authorization).id === authorizationId) {
        return {
          project: structuredClone(this.current),
          run: structuredClone(currentBatch),
          snapshotRelativePath: null,
          deduplicated: true
        };
      }
      if (currentBatch.id && !new Set(["completed", "paused"]).has(String(currentBatch.status))) {
        throw new ProtocolError("TASK_LOCKED", "当前项目已有未暂停的批次，请先完成或暂停后再创建 B 模式批次");
      }
      const stage = requiredString(value.stage, "stage");
      if (!new Set(["preflight", "scene-optimization", "final-glass"]).has(stage)) {
        throw new ProtocolError("INVALID_INPUT", "Codex 批次阶段无效");
      }
      const action = requiredString(value.action, "action");
      const allowedActions: Record<string, Set<string>> = {
        preflight: new Set(["analyze"]),
        "scene-optimization": new Set(["generate"]),
        "final-glass": new Set(["generate"])
      };
      if (!allowedActions[stage]?.has(action)) throw new ProtocolError("INVALID_INPUT", "阶段与操作不匹配");
      const sourceVersionIds = requiredArray(value.sourceVersionIds, "sourceVersionIds").map((item) => String(item));
      const uniqueSourceVersionIds = [...new Set(sourceVersionIds)];
      if (!uniqueSourceVersionIds.length || uniqueSourceVersionIds.length > 200) {
        throw new ProtocolError("INVALID_INPUT", "Codex 批次须包含 1–200 个输入项");
      }
      const versions = requiredArray(this.current.versions, "versions");
      const versionMap = new Map(versions.filter(isRecord).map((version) => [String(version.id), version]));
      const nodes = requiredArray(optionalRecord(this.current.canvas).nodes, "canvas.nodes").filter(isRecord);
      const nodeByVersion = new Map(nodes
        .filter((node) => node.type === "image" && isRecord(node.payload))
        .map((node) => [String(optionalRecord(node.payload).imageVersionId), node]));
      for (const sourceVersionId of uniqueSourceVersionIds) {
        if (!versionMap.has(sourceVersionId) || !nodeByVersion.has(sourceVersionId)) {
          throw new ProtocolError("RECOVERY_REQUIRED", `Codex 批次输入版本不存在：${sourceVersionId}`);
        }
      }
      const maximumGenerations = value.maximumGenerations;
      if (!Number.isInteger(maximumGenerations) || (maximumGenerations as number) < 0 || (maximumGenerations as number) > 200) {
        throw new ProtocolError("INVALID_INPUT", "maximumGenerations 须为 0–200 的整数");
      }
      const isGeneration = action === "generate";
      if ((!isGeneration && maximumGenerations !== 0) || (isGeneration && (maximumGenerations as number) < uniqueSourceVersionIds.length)) {
        throw new ProtocolError("INVALID_INPUT", "授权生成上限与本批次操作或项目数不匹配");
      }
      const sourceFolder = value.sourceFolder === null ? null : boundedString(value.sourceFolder, "sourceFolder", 1_000);
      if (sourceFolder !== null && (!sourceFolder || !isAbsolute(sourceFolder))) {
        throw new ProtocolError("INVALID_INPUT", "授权源文件夹必须是绝对路径");
      }
      const now = new Date().toISOString();
      const batchId = `batch_${randomUUID()}`;
      const workflow = structuredClone(currentWorkflow);
      const viewpoints = Array.isArray(workflow.viewpoints) ? workflow.viewpoints.filter(isRecord) : [];
      const prompt = typeof value.prompt === "string" ? value.prompt.trim().slice(0, 12_000) : "";
      const items = uniqueSourceVersionIds.map((sourceVersionId) => {
        const node = nodeByVersion.get(sourceVersionId) as JsonObject;
        const payload = optionalRecord(node.payload);
        const viewpoint = viewpoints.find((candidate) => (
          String(optionalRecord(candidate.preflight).d5ViewVersionId) === sourceVersionId
          || String(optionalRecord(candidate.sceneOptimization).structureBaseVersionId) === sourceVersionId
          || String(optionalRecord(candidate.finalGlass).finalD5VersionId) === sourceVersionId
          || String(candidate.sourceVersionId) === sourceVersionId
        ));
        const suVersionId = stage === "preflight" ? optionalRecord(viewpoint?.preflight).suReferenceVersionId : null;
        const styleVersionId = stage === "scene-optimization" && typeof value.styleReferenceVersionId === "string"
          ? value.styleReferenceVersionId
          : null;
        const attachmentVersionIds = [sourceVersionId, suVersionId, styleVersionId]
          .filter((candidate, index, all): candidate is string => typeof candidate === "string" && versionMap.has(candidate) && all.indexOf(candidate) === index);
        const attachmentRoles = stage === "preflight"
          ? attachmentVersionIds.map((_, index) => index === 0 ? "d5-locked-view" : "su-reference")
          : stage === "scene-optimization"
            ? attachmentVersionIds.map((_, index) => index === 0 ? "structure-base" : "style-reference")
            : ["structure-base"];
        return {
          id: `batch_item_${randomUUID()}`,
          sourceVersionId,
          sourceName: typeof payload.name === "string" ? payload.name.slice(0, 260) : sourceVersionId,
          attachmentVersionIds,
          attachmentRoles,
          outputKind: stage === "preflight" ? "preflight-review" : stage === "scene-optimization" ? "d5-scene-target" : "glass-deepened-full-frame",
          resultTextCardId: null,
          status: "queued",
          taskId: null,
          resultVersionIds: [],
          error: "",
          runner: "codex",
          checkpoint: "manifest-confirmed",
          idempotencyKey: `codex:${authorizationId}:${stage}:${action}:${sourceVersionId}`,
          attemptCount: 0,
          sourceHash: null,
          promptHash: null
        };
      });
      const run: JsonObject = {
        id: batchId,
        status: "ready",
        prompt,
        promptMode: "stage-only",
        workflowStage: stage,
        responseMode: isGeneration ? "image" : "text",
        workflowAction: action,
        rulesetVersion: "D5-RULESET-3.0",
        styleReferenceVersionId: typeof value.styleReferenceVersionId === "string" ? value.styleReferenceVersionId : null,
        targetChatUrl: null,
        items,
        runner: "codex",
        authorization: {
          id: authorizationId,
          sourceFolder,
          stage,
          itemCount: items.length,
          maximumGenerations,
          allowManualFallback: value.allowManualFallback === true,
          stopOnStructureRisk: value.stopOnStructureRisk !== false,
          approvedAt: typeof value.approvedAt === "string" && value.approvedAt.trim() ? value.approvedAt : now
        },
        codexThreadId: typeof value.codexThreadId === "string" ? value.codexThreadId.trim().slice(0, 500) || null : null,
        leaseOwner: null,
        leaseExpiresAt: null,
        createdAt: now,
        updatedAt: now
      };
      workflow.batchRun = run;
      const next = validateProject({
        ...structuredClone(this.current),
        updatedAt: now,
        revision: Number(this.current.revision) + 1,
        workflow
      });
      const saved = await this.writeValidatedProject(next, true);
      return { ...saved, run: structuredClone(run), deduplicated: false };
    });
  }

  async registerCodexTextCard(value: unknown): Promise<{ project: JsonObject; card: JsonObject; run: JsonObject; snapshotRelativePath: string | null; deduplicated: boolean }> {
    return this.exclusive(async () => {
      if (!this.current || !isRecord(value)) throw new ProtocolError("INVALID_INPUT", "文字卡登记请求无效");
      const runId = requiredString(value.runId, "runId");
      const authorizationId = requiredString(value.authorizationId, "authorizationId");
      const sourceVersionId = requiredString(value.sourceVersionId, "sourceVersionId");
      const idempotencyKey = boundedString(value.idempotencyKey, "idempotencyKey", 500);
      if (!idempotencyKey) throw new ProtocolError("INVALID_INPUT", "idempotencyKey 无效");
      const workflow = structuredClone(optionalRecord(this.current.workflow));
      const run = optionalRecord(workflow.batchRun);
      const authorization = optionalRecord(run.authorization);
      if (run.id !== runId || run.runner !== "codex" || authorization.id !== authorizationId) {
        throw new ProtocolError("TASK_LOCKED", "Codex 批次或授权单与当前项目不匹配");
      }
      const expectedKind = run.workflowStage === "preflight" && run.workflowAction === "analyze"
        ? "review"
        : run.workflowStage === "scene-optimization" && run.workflowAction === "generate"
          ? "prompt"
          : null;
      if (!expectedKind || value.kind !== expectedKind) {
        throw new ProtocolError("INVALID_TRANSITION", "当前阶段与文字卡类型不匹配");
      }
      const cards = Array.isArray(workflow.textCards) ? workflow.textCards.filter(isRecord) : [];
      const existing = cards.find((card) => card.idempotencyKey === idempotencyKey);
      if (existing) {
        return {
          project: structuredClone(this.current),
          card: structuredClone(existing),
          run: structuredClone(run),
          snapshotRelativePath: null,
          deduplicated: true
        };
      }
      if (run.status === "paused" || run.status === "completed") {
        throw new ProtocolError("INVALID_TRANSITION", "暂停或已完成的批次不能登记新文字卡");
      }
      const items = requiredArray(run.items, "run.items").filter(isRecord);
      const itemIndex = items.findIndex((item) => item.sourceVersionId === sourceVersionId);
      if (itemIndex < 0) throw new ProtocolError("TASK_LOCKED", "文字卡来源不在当前授权批次内");
      if (typeof items[itemIndex]?.resultTextCardId === "string") {
        throw new ProtocolError("INVALID_TRANSITION", "当前任务项已经登记过文字卡");
      }
      const text = boundedString(value.text, "text", 20_000).trim();
      if (!text) throw new ProtocolError("INVALID_INPUT", "文字卡内容不能为空");
      const kind = value.kind === "prompt" ? "prompt" : "review";
      const nodes = requiredArray(optionalRecord(this.current.canvas).nodes, "canvas.nodes").filter(isRecord);
      const sourceNode = nodes.find((node) => node.type === "image" && optionalRecord(node.payload).imageVersionId === sourceVersionId);
      if (!sourceNode) throw new ProtocolError("RECOVERY_REQUIRED", "文字卡来源图片节点不存在");
      const now = new Date().toISOString();
      const width = 460;
      const height = 360;
      const siblings = cards.filter((card) => card.sourceVersionId === sourceVersionId).length;
      const card: JsonObject = {
        id: `text_card_${randomUUID()}`,
        kind,
        title: (typeof value.title === "string" ? value.title.trim() : "").slice(0, 120) || (kind === "prompt" ? "生成提示词" : "Codex 前置审查"),
        text,
        x: Number(sourceNode.x) - width - 72,
        y: Number(sourceNode.y) + siblings * (height + 36),
        width,
        height,
        sourceVersionId,
        taskId: `task_codex_${randomUUID()}`,
        workflowLabel: (typeof value.workflowLabel === "string" ? value.workflowLabel.trim() : "").slice(0, 120) || (kind === "prompt" ? "阶段02 · 场景优化提示词" : "阶段01 · 前置检查"),
        handoffState: "pending",
        idempotencyKey,
        createdAt: now,
        updatedAt: now
      };
      cards.push(card);
      workflow.textCards = cards;
      const item = { ...items[itemIndex] };
      const promptContinuesToGeneration = kind === "prompt"
        && run.workflowStage === "scene-optimization"
        && run.workflowAction === "generate";
      item.status = promptContinuesToGeneration ? "queued" : "completed";
      item.resultTextCardId = card.id;
      item.checkpoint = kind === "prompt" ? "prompt-approved" : "analysis-completed";
      item.error = "";
      items[itemIndex] = item;
      run.items = items;
      run.status = items.every((candidate) => candidate.status === "completed" || candidate.status === "failed") ? "completed" : "running";
      run.updatedAt = now;
      workflow.batchRun = run;
      const viewpoints = Array.isArray(workflow.viewpoints) ? workflow.viewpoints.filter(isRecord) : [];
      workflow.viewpoints = viewpoints.map((viewpoint) => {
        if (String(viewpoint.sourceVersionId) !== sourceVersionId
          && String(optionalRecord(viewpoint.preflight).d5ViewVersionId) !== sourceVersionId
          && String(optionalRecord(viewpoint.sceneOptimization).structureBaseVersionId) !== sourceVersionId) return viewpoint;
        if (kind === "review") {
          return {
            ...viewpoint,
            stage: "preflight",
            status: "in-progress",
            conclusion: text.slice(0, 1_000),
            nextAction: "人工确认审查意见后进入场景优化",
            preflight: { ...optionalRecord(viewpoint.preflight), conclusionCardId: card.id, status: "completed" },
            updatedAt: now
          };
        }
        return {
          ...viewpoint,
          stage: "scene-optimization",
          status: "in-progress",
          sceneOptimization: { ...optionalRecord(viewpoint.sceneOptimization), promptCardId: card.id, status: "prompt-ready" },
          updatedAt: now
        };
      });
      const next = validateProject({
        ...structuredClone(this.current),
        updatedAt: now,
        revision: Number(this.current.revision) + 1,
        workflow
      });
      const saved = await this.writeValidatedProject(next, true);
      return { ...saved, card: structuredClone(card), run: structuredClone(run), deduplicated: false };
    });
  }

  async transitionCodexRun(value: unknown): Promise<{ project: JsonObject; run: JsonObject; snapshotRelativePath: string | null }> {
    return this.exclusive(async () => {
      if (!this.current || !isRecord(value)) throw new ProtocolError("INVALID_INPUT", "Codex 批次状态请求无效");
      const runId = requiredString(value.runId, "runId");
      const action = requiredString(value.action, "action");
      if (action !== "pause" && action !== "resume") throw new ProtocolError("INVALID_INPUT", "Codex 批次状态操作无效");
      const workflow = structuredClone(optionalRecord(this.current.workflow));
      const run = optionalRecord(workflow.batchRun);
      if (run.id !== runId || run.runner !== "codex") throw new ProtocolError("TASK_LOCKED", "Codex 批次不是当前活动批次");
      if (action === "pause" && !new Set(["ready", "running"]).has(String(run.status))) {
        throw new ProtocolError("INVALID_TRANSITION", "当前批次不能暂停");
      }
      if (action === "resume" && run.status !== "paused") throw new ProtocolError("INVALID_TRANSITION", "只有暂停批次可以恢复");
      const now = new Date().toISOString();
      if (action === "resume" && run.workflowStage === "scene-optimization" && run.workflowAction === "generate") {
        const authorization = optionalRecord(run.authorization);
        let items = requiredArray(run.items, "run.items").filter(isRecord);
        items = items.map((item) => (
          item.status === "failed"
          && item.checkpoint === "generation-submitted"
          && String(item.error).includes("恢复项目时未找到对应的活动任务")
            ? { ...item, status: "running", error: "B 模式检查点已恢复，等待登记已生成结果" }
            : item
        ));
        run.items = items;
        const attemptedTotal = items.reduce((sum, candidate) => (
          sum + (Number.isInteger(candidate.attemptCount) ? Number(candidate.attemptCount) : 0)
        ), 0);
        if (authorization.stopOnStructureRisk === true && attemptedTotal < Number(authorization.maximumGenerations)) {
          run.items = items.map((item, index) => {
            const itemBudgetBase = Math.floor(Number(authorization.maximumGenerations) / items.length);
            const itemBudgetRemainder = Number(authorization.maximumGenerations) % items.length;
            const itemGenerationBudget = itemBudgetBase + (index < itemBudgetRemainder ? 1 : 0);
            const retryableLegacyRisk = item.status === "failed"
              && item.checkpoint === "result-registered"
              && typeof item.resultTextCardId === "string"
              && Number(item.attemptCount ?? 0) < itemGenerationBudget;
            return retryableLegacyRisk
              ? {
                  ...item,
                  status: "queued",
                  checkpoint: "prompt-approved",
                  error: `${String(item.error || "结构风险候选已拒收")}；已按 0.5.3 恢复，将自动补生`.slice(0, 1_000)
                }
              : item;
          });
          const requeuedSourceIds = new Set(requiredArray(run.items, "run.items").filter(isRecord)
            .filter((item) => item.status === "queued" && String(item.error).includes("已按 0.5.3 恢复"))
            .map((item) => String(item.sourceVersionId)));
          if (requeuedSourceIds.size && Array.isArray(workflow.viewpoints)) {
            workflow.viewpoints = workflow.viewpoints.filter(isRecord).map((viewpoint) => (
              requeuedSourceIds.has(String(viewpoint.sourceVersionId))
                ? { ...viewpoint, status: "in-progress", updatedAt: now }
                : viewpoint
            ));
          }
        }
      }
      run.status = action === "pause" ? "paused" : "running";
      run.leaseOwner = action === "resume" ? (typeof value.leaseOwner === "string" ? value.leaseOwner.trim().slice(0, 500) || "codex" : "codex") : null;
      run.leaseExpiresAt = action === "resume" ? new Date(Date.now() + 5 * 60_000).toISOString() : null;
      run.updatedAt = now;
      workflow.batchRun = run;
      const next = validateProject({ ...structuredClone(this.current), updatedAt: now, revision: Number(this.current.revision) + 1, workflow });
      const saved = await this.writeValidatedProject(next, true);
      return { ...saved, run: structuredClone(run) };
    });
  }

  readCodexRunItemInputs(value: unknown): JsonObject {
    if (!this.current || !isRecord(value)) throw new ProtocolError("INVALID_INPUT", "Codex 输入读取请求无效");
    const runId = requiredString(value.runId, "runId");
    const itemId = requiredString(value.itemId, "itemId");
    const workflow = optionalRecord(this.current.workflow);
    const run = optionalRecord(workflow.batchRun);
    if (run.id !== runId) throw new ProtocolError("TASK_LOCKED", "Codex 批次不是当前活动批次");
    const item = requiredArray(run.items, "run.items").filter(isRecord).find((candidate) => candidate.id === itemId);
    if (!item) throw new ProtocolError("TASK_NOT_FOUND", "Codex 批次项目不存在");
    const versions = new Map(requiredArray(this.current.versions, "versions").filter(isRecord).map((version) => [String(version.id), version]));
    const assets = new Map(requiredArray(this.current.assets, "assets").filter(isRecord).map((asset) => [String(asset.id), asset]));
    const attachmentVersionIds = requiredArray(item.attachmentVersionIds, "item.attachmentVersionIds").map(String);
    const attachmentRoles = requiredArray(item.attachmentRoles, "item.attachmentRoles").map(String);
    const approvedPromptCard = Array.isArray(workflow.textCards)
      ? workflow.textCards.filter(isRecord).find((card) => card.id === item.resultTextCardId && card.kind === "prompt")
      : undefined;
    const approvedPrompt = typeof approvedPromptCard?.text === "string" ? approvedPromptCard.text.trim() : "";
    const inputs = attachmentVersionIds.map((versionId, index) => {
      const version = versions.get(versionId);
      const asset = version ? assets.get(String(version.assetId)) : undefined;
      const original = optionalRecord(asset?.original);
      if (!version || !asset || typeof original.relativePath !== "string") {
        throw new ProtocolError("RECOVERY_REQUIRED", `Codex 输入资产不存在：${versionId}`);
      }
      const absolutePath = resolve(this.projectRoot, original.relativePath);
      if (absolutePath !== this.projectRoot && !absolutePath.startsWith(`${this.projectRoot}\\`) && !absolutePath.startsWith(`${this.projectRoot}/`)) {
        throw new ProtocolError("RECOVERY_REQUIRED", "Codex 输入资产路径越界");
      }
      return {
        versionId,
        role: attachmentRoles[index] ?? "content-reference",
        assetId: asset.id,
        name: asset.originalName,
        absolutePath,
        mime: original.mime,
        width: original.width,
        height: original.height,
        sha256: original.sha256
      };
    });
    return {
      schemaVersion: "1.0",
      runId,
      itemId,
      runner: item.runner,
      checkpoint: item.checkpoint ?? null,
      idempotencyKey: item.idempotencyKey,
      workflowStage: run.workflowStage,
      workflowAction: run.workflowAction,
      outputKind: item.outputKind,
      prompt: approvedPrompt || run.prompt,
      runInstruction: run.prompt,
      inputs
    };
  }

  async markCodexGenerationSubmitted(value: unknown): Promise<{ project: JsonObject; run: JsonObject; item: JsonObject; snapshotRelativePath: string | null; deduplicated: boolean }> {
    return this.exclusive(async () => {
      if (!this.current || !isRecord(value)) throw new ProtocolError("INVALID_INPUT", "Codex 生图提交请求无效");
      const runId = requiredString(value.runId, "runId");
      const itemId = requiredString(value.itemId, "itemId");
      const authorizationId = requiredString(value.authorizationId, "authorizationId");
      const workflow = structuredClone(optionalRecord(this.current.workflow));
      const run = optionalRecord(workflow.batchRun);
      const authorization = optionalRecord(run.authorization);
      if (run.id !== runId || run.runner !== "codex" || authorization.id !== authorizationId) {
        throw new ProtocolError("TASK_LOCKED", "Codex 批次或授权单不匹配");
      }
      if (run.workflowAction !== "generate" || run.status === "paused" || run.status === "completed") {
        throw new ProtocolError("INVALID_TRANSITION", "当前 Codex 批次不能提交生图");
      }
      const items = requiredArray(run.items, "run.items").filter(isRecord);
      const itemIndex = items.findIndex((candidate) => candidate.id === itemId);
      if (itemIndex < 0) throw new ProtocolError("TASK_NOT_FOUND", "Codex 批次项目不存在");
      const item = { ...items[itemIndex] };
      const requestedLeaseOwner = typeof value.leaseOwner === "string"
        ? value.leaseOwner.trim().slice(0, 500) || "codex"
        : "codex";
      if (item.checkpoint === "generation-submitted") {
        if (typeof run.leaseOwner === "string" && run.leaseOwner !== requestedLeaseOwner) {
          throw new ProtocolError("TASK_LOCKED", "该生图检查点已由其他 Codex 执行器持有");
        }
        return { project: structuredClone(this.current), run: structuredClone(run), item, snapshotRelativePath: null, deduplicated: true };
      }
      const currentLeaseExpiry = typeof run.leaseExpiresAt === "string" ? Date.parse(run.leaseExpiresAt) : Number.NaN;
      if (
        typeof run.leaseOwner === "string"
        && run.leaseOwner !== requestedLeaseOwner
        && Number.isFinite(currentLeaseExpiry)
        && currentLeaseExpiry > Date.now()
      ) {
        throw new ProtocolError("TASK_LOCKED", "当前 Codex 批次租约仍由其他执行器持有");
      }
      const firstPending = items.find((candidate) => candidate.status === "queued" || candidate.status === "running");
      if (firstPending?.id !== itemId) throw new ProtocolError("TASK_LOCKED", "Codex 生图必须按画布顺序严格串行");
      const attempted = items.reduce((sum, candidate) => sum + (Number.isInteger(candidate.attemptCount) ? Number(candidate.attemptCount) : 0), 0);
      if (attempted >= Number(authorization.maximumGenerations)) {
        throw new ProtocolError("TASK_LOCKED", "本批次生成授权上限已用尽");
      }
      const sourceVersion = requiredArray(this.current.versions, "versions").filter(isRecord).find((version) => version.id === item.sourceVersionId);
      const sourceAsset = sourceVersion
        ? requiredArray(this.current.assets, "assets").filter(isRecord).find((asset) => asset.id === sourceVersion.assetId)
        : undefined;
      const now = new Date().toISOString();
      item.status = "running";
      item.checkpoint = "generation-submitted";
      item.attemptCount = Number(item.attemptCount ?? 0) + 1;
      item.sourceHash = optionalRecord(sourceAsset?.original).sha256 ?? null;
      const approvedPromptCard = Array.isArray(workflow.textCards)
        ? workflow.textCards.filter(isRecord).find((card) => card.id === item.resultTextCardId && card.kind === "prompt")
        : undefined;
      const effectivePrompt = typeof approvedPromptCard?.text === "string" && approvedPromptCard.text.trim()
        ? approvedPromptCard.text.trim()
        : String(run.prompt ?? "");
      item.promptHash = createHash("sha256").update(effectivePrompt, "utf8").digest("hex");
      items[itemIndex] = item;
      run.items = items;
      run.status = "running";
      run.leaseOwner = requestedLeaseOwner;
      run.leaseExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      run.updatedAt = now;
      workflow.batchRun = run;
      const next = validateProject({ ...structuredClone(this.current), updatedAt: now, revision: Number(this.current.revision) + 1, workflow });
      const saved = await this.writeValidatedProject(next, true);
      return { ...saved, run: structuredClone(run), item: structuredClone(item), deduplicated: false };
    });
  }

  async registerCodexGeneratedResult(
    value: unknown,
    generatedAsset: CanvasImageAsset
  ): Promise<{ project: JsonObject; run: JsonObject; item: JsonObject; versionId: string; validation: JsonObject; snapshotRelativePath: string | null; deduplicated: boolean }> {
    return this.exclusive(async () => {
      if (!this.current || !isRecord(value)) throw new ProtocolError("INVALID_INPUT", "Codex 结果登记请求无效");
      const runId = requiredString(value.runId, "runId");
      const itemId = requiredString(value.itemId, "itemId");
      const authorizationId = requiredString(value.authorizationId, "authorizationId");
      const workflow = structuredClone(optionalRecord(this.current.workflow));
      const run = optionalRecord(workflow.batchRun);
      const authorization = optionalRecord(run.authorization);
      if (run.id !== runId || run.runner !== "codex" || authorization.id !== authorizationId) {
        throw new ProtocolError("TASK_LOCKED", "Codex 批次或授权单不匹配");
      }
      const items = requiredArray(run.items, "run.items").filter(isRecord);
      const itemIndex = items.findIndex((candidate) => candidate.id === itemId);
      if (itemIndex < 0) throw new ProtocolError("TASK_NOT_FOUND", "Codex 批次项目不存在");
      const item = { ...items[itemIndex] };
      const versions = requiredArray(this.current.versions, "versions").filter(isRecord);
      const assets = requiredArray(this.current.assets, "assets").filter(isRecord);
      const existingVersion = versions.find((version) => version.assetId === generatedAsset.id && version.parentVersionId === item.sourceVersionId);
      const existingVersionId = existingVersion ? String(existingVersion.id) : null;
      if (
        existingVersionId
        && requiredArray(item.resultVersionIds, "item.resultVersionIds").map(String).includes(existingVersionId)
        && (item.status === "completed" || item.status === "failed")
      ) {
        return {
          project: structuredClone(this.current), run: structuredClone(run), item,
          versionId: existingVersionId, validation: { passed: item.status === "completed", reason: item.error || "已登记" },
          snapshotRelativePath: null, deduplicated: true
        };
      }
      if (item.checkpoint !== "generation-submitted" || item.status !== "running") {
        throw new ProtocolError("INVALID_TRANSITION", "必须先登记 generation-submitted 检查点");
      }
      const leaseOwner = boundedString(value.leaseOwner, "leaseOwner", 500).trim();
      if (!leaseOwner || run.leaseOwner !== leaseOwner) {
        throw new ProtocolError("TASK_LOCKED", "Codex 结果登记者与当前生图租约不匹配");
      }
      if (generatedAsset.kind !== "generated") throw new ProtocolError("INVALID_INPUT", "Codex 结果资产类型无效");
      const sourceVersion = versions.find((version) => version.id === item.sourceVersionId);
      const sourceAsset = sourceVersion ? assets.find((asset) => asset.id === sourceVersion.assetId) : undefined;
      const sourceOriginal = optionalRecord(sourceAsset?.original);
      if (!sourceVersion || !sourceAsset) throw new ProtocolError("RECOVERY_REQUIRED", "Codex 结果父版本不存在");
      if (typeof item.sourceHash === "string" && sourceOriginal.sha256 !== item.sourceHash) {
        throw new ProtocolError("TASK_LOCKED", "生图提交后结构底图已变化，拒绝登记过期结果");
      }
      const approvedPromptCard = Array.isArray(workflow.textCards)
        ? workflow.textCards.filter(isRecord).find((card) => card.id === item.resultTextCardId && card.kind === "prompt")
        : undefined;
      const effectivePrompt = typeof approvedPromptCard?.text === "string" && approvedPromptCard.text.trim()
        ? approvedPromptCard.text.trim()
        : String(run.prompt ?? "");
      const currentPromptHash = createHash("sha256").update(effectivePrompt, "utf8").digest("hex");
      if (typeof item.promptHash === "string" && currentPromptHash !== item.promptHash) {
        throw new ProtocolError("TASK_LOCKED", "生图提交后提示词已变化，拒绝登记过期结果");
      }
      const sourceWidth = Number(sourceOriginal.width);
      const sourceHeight = Number(sourceOriginal.height);
      const resultWidth = generatedAsset.original.width;
      const resultHeight = generatedAsset.original.height;
      const ratioDelta = Math.abs((resultWidth / resultHeight) - (sourceWidth / sourceHeight)) / (sourceWidth / sourceHeight);
      const ratioMatches = Number.isFinite(ratioDelta) && ratioDelta <= 0.005;
      const dimensionsMatch = resultWidth === sourceWidth && resultHeight === sourceHeight;
      const structureRisk = value.structureRisk === "confirmed" ? "confirmed" : value.structureRisk === "suspected" ? "suspected" : "none";
      const stage = String(run.workflowStage);
      const passed = ratioMatches && structureRisk === "none" && (stage !== "final-glass" || dimensionsMatch);
      const reasons = [
        ...(ratioMatches ? [] : ["结果宽高比与原图不一致"]),
        ...(stage === "final-glass" && !dimensionsMatch ? ["最终玻璃深化结果尺寸与原图不一致"] : []),
        ...(structureRisk === "none" ? [] : [`结构风险：${structureRisk}`])
      ];
      const now = new Date().toISOString();
      const versionId = existingVersionId ?? `version_${randomUUID()}`;
      const taskId = typeof existingVersion?.taskId === "string" ? existingVersion.taskId : `task_codex_${randomUUID()}`;
      const sourceNode = requiredArray(optionalRecord(this.current.canvas).nodes, "canvas.nodes").filter(isRecord)
        .find((node) => node.type === "image" && optionalRecord(node.payload).imageVersionId === item.sourceVersionId);
      if (!sourceNode) throw new ProtocolError("RECOVERY_REQUIRED", "Codex 结果父图片节点不存在");
      const siblingCount = versions.filter((version) => version.parentVersionId === item.sourceVersionId).length;
      const resultNode: JsonObject = {
        id: `node_${randomUUID()}`,
        type: "image",
        x: Number(sourceNode.x) + Number(sourceNode.width) + 72,
        y: Number(sourceNode.y) + siblingCount * (Number(sourceNode.height) + 36),
        width: Number(sourceNode.width),
        height: Number(sourceNode.height),
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        zIndex: requiredArray(optionalRecord(this.current.canvas).nodes, "canvas.nodes").length,
        locked: false,
        visible: true,
        payload: {
          imageVersionId: versionId,
          fit: "cover",
          name: generatedAsset.originalName,
          sourceWidth: resultWidth,
          sourceHeight: resultHeight,
          validation: passed ? "passed" : "failed",
          structureRisk
        }
      };
      const nextAssets = assets.some((asset) => asset.id === generatedAsset.id) ? assets : [...assets, generatedAsset];
      const nextVersions = existingVersion ? versions : [...versions, {
        id: versionId,
        assetId: generatedAsset.id,
        origin: "generated",
        parentVersionId: item.sourceVersionId,
        taskId,
        createdAt: now
      }];
      const taskLinks = requiredArray(this.current.taskLinks, "taskLinks").filter(isRecord);
      if (!existingVersion) {
        taskLinks.push({ taskId, parentVersionId: item.sourceVersionId, resultVersionIds: [versionId], status: "completed" });
      }
      item.resultVersionIds = [...new Set([...requiredArray(item.resultVersionIds, "item.resultVersionIds").map(String), versionId])];
      const attemptedTotal = items.reduce((sum, candidate) => (
        sum + (Number.isInteger(candidate.attemptCount) ? Number(candidate.attemptCount) : 0)
      ), 0);
      const itemBudgetBase = Math.floor(Number(authorization.maximumGenerations) / items.length);
      const itemBudgetRemainder = Number(authorization.maximumGenerations) % items.length;
      const itemGenerationBudget = itemBudgetBase + (itemIndex < itemBudgetRemainder ? 1 : 0);
      const canRetrySceneCandidate = !passed
        && stage === "scene-optimization"
        && authorization.stopOnStructureRisk === true
        && Number(item.attemptCount ?? 0) < itemGenerationBudget
        && attemptedTotal < Number(authorization.maximumGenerations);
      item.checkpoint = passed ? "validation-completed" : canRetrySceneCandidate ? "prompt-approved" : "result-registered";
      item.status = passed ? "completed" : canRetrySceneCandidate ? "queued" : "failed";
      item.error = passed
        ? ""
        : canRetrySceneCandidate
          ? `第 ${Number(item.attemptCount ?? 0)}/${itemGenerationBudget} 张候选已拒收：${reasons.join("；")}；将自动补生`.slice(0, 1_000)
          : `${reasons.join("；")}；该底图 ${Number(item.attemptCount ?? 0)}/${itemGenerationBudget} 次额度已用尽，继续下一视角`.slice(0, 1_000);
      items[itemIndex] = item;
      run.items = items;
      const mustPause = !passed && stage === "final-glass";
      run.status = mustPause
        ? "paused"
        : items.every((candidate) => candidate.status === "completed" || candidate.status === "failed") ? "completed" : "running";
      run.leaseOwner = null;
      run.leaseExpiresAt = null;
      run.updatedAt = now;
      workflow.batchRun = run;
      const viewpoints = Array.isArray(workflow.viewpoints) ? workflow.viewpoints.filter(isRecord) : [];
      workflow.viewpoints = viewpoints.map((viewpoint) => {
        const matches = String(viewpoint.sourceVersionId) === item.sourceVersionId
          || String(optionalRecord(viewpoint.sceneOptimization).structureBaseVersionId) === item.sourceVersionId
          || String(optionalRecord(viewpoint.finalGlass).finalD5VersionId) === item.sourceVersionId;
        if (!matches) return viewpoint;
        if (stage === "scene-optimization") {
          const scene = optionalRecord(viewpoint.sceneOptimization);
          return {
            ...viewpoint,
            stage,
            status: passed || canRetrySceneCandidate ? "in-progress" : "blocked",
            sceneOptimization: {
              ...scene,
              candidateVersionIds: [...new Set([...requiredArray(scene.candidateVersionIds, "candidateVersionIds").map(String), versionId])],
              status: "generated"
            },
            updatedAt: now
          };
        }
        if (stage === "final-glass") {
          const finalGlass = optionalRecord(viewpoint.finalGlass);
          return { ...viewpoint, stage, status: passed ? "in-progress" : "blocked", finalGlass: { ...finalGlass, candidateVersionIds: [...new Set([...requiredArray(finalGlass.candidateVersionIds, "candidateVersionIds").map(String), versionId])], validation: passed ? "passed" : "failed", status: "generated" }, updatedAt: now };
        }
        return viewpoint;
      });
      const next = validateProject({
        ...structuredClone(this.current), updatedAt: now, revision: Number(this.current.revision) + 1,
        assets: nextAssets, versions: nextVersions, taskLinks,
        canvas: {
          ...optionalRecord(this.current.canvas),
          nodes: existingVersion
            ? requiredArray(optionalRecord(this.current.canvas).nodes, "canvas.nodes")
            : [...requiredArray(optionalRecord(this.current.canvas).nodes, "canvas.nodes"), resultNode]
        },
        workflow
      });
      const saved = await this.writeValidatedProject(next, true);
      return {
        ...saved, run: structuredClone(run), item: structuredClone(item), versionId,
        validation: {
          passed,
          ratioMatches,
          dimensionsMatch,
          structureRisk,
          reasons,
          retryScheduled: canRetrySceneCandidate,
          itemGenerationBudget,
          itemAttemptsUsed: Number(item.attemptCount ?? 0)
        },
        deduplicated: Boolean(existingVersion)
      };
    });
  }

  async handoffRun(value: unknown): Promise<{ project: JsonObject; run: JsonObject; snapshotRelativePath: string | null }> {
    return this.exclusive(async () => {
      if (!this.current || !isRecord(value)) throw new ProtocolError("INVALID_INPUT", "A/B 接管请求无效");
      const runId = requiredString(value.runId, "runId");
      const targetRunner = value.targetRunner === "manual" ? "manual" : value.targetRunner === "codex" ? "codex" : null;
      if (!targetRunner) throw new ProtocolError("INVALID_INPUT", "接管目标执行器无效");
      const workflow = structuredClone(optionalRecord(this.current.workflow));
      const run = optionalRecord(workflow.batchRun);
      if (run.id !== runId || run.status !== "paused") throw new ProtocolError("INVALID_TRANSITION", "只有已暂停批次可以切换执行器");
      const items = requiredArray(run.items, "run.items").filter(isRecord);
      if (items.some((item) => item.status === "running" || item.checkpoint === "generation-submitted")) {
        throw new ProtocolError("TASK_LOCKED", "存在已提交但尚未回收结果的任务项，不能切换执行器");
      }
      const protectedCheckpoints = new Set(["result-registered", "validation-completed", "human-selected", "exported"]);
      const transferableIds = new Set(items
        .filter((item) => item.status === "queued" || (item.status === "failed" && !protectedCheckpoints.has(String(item.checkpoint))))
        .map((item) => String(item.id)));
      if (!transferableIds.size) throw new ProtocolError("TASK_LOCKED", "没有可安全接管的未完成任务项");
      const now = new Date().toISOString();
      run.items = items.map((item) => !transferableIds.has(String(item.id))
        ? item
        : { ...item, runner: targetRunner, status: item.status === "failed" ? "queued" : item.status, error: item.status === "failed" ? "" : item.error });
      run.runner = targetRunner;
      run.status = "ready";
      run.leaseOwner = null;
      run.leaseExpiresAt = null;
      run.updatedAt = now;
      workflow.batchRun = run;
      const next = validateProject({ ...structuredClone(this.current), updatedAt: now, revision: Number(this.current.revision) + 1, workflow });
      const saved = await this.writeValidatedProject(next, true);
      return { ...saved, run: structuredClone(run) };
    });
  }

  private async writeValidatedProject(
    project: JsonObject,
    forceSnapshot: boolean
  ): Promise<{ project: JsonObject; snapshotRelativePath: string | null }> {
      const revision = project.revision as number;
      const currentRevision = (this.current?.revision as number | undefined) ?? -1;
      if (revision < currentRevision) {
        throw new ProtocolError("INVALID_TRANSITION", `旧修订 ${revision} 不能覆盖当前修订 ${currentRevision}`);
      }
      if (
        revision === currentRevision
        && this.current
        && JSON.stringify({ ...project, updatedAt: this.current.updatedAt }) !== JSON.stringify(this.current)
      ) {
        throw new ProtocolError(
          "INVALID_TRANSITION",
          `修订 ${revision} 已被其他操作更新，请重新载入项目后再保存`
        );
      }
      if (revision === currentRevision && this.current) {
        return { project: structuredClone(this.current), snapshotRelativePath: null };
      }
      const payload = `${JSON.stringify(project, null, 2)}\n`;
      const temporary = `${this.projectPath}.${randomUUID()}.tmp`;
      await writeFile(temporary, payload, { encoding: "utf8", flag: "wx" });
      await rename(temporary, this.projectPath);
      this.current = project;

      let snapshotRelativePath: string | null = null;
      if (revision > currentRevision && (forceSnapshot || (revision > 0 && revision % 20 === 0))) {
        const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
        const filename = `project_rev${String(revision).padStart(6, "0")}_${stamp}.json`;
        const snapshotPath = join(this.snapshotsRoot, filename);
        await writeFile(snapshotPath, payload, { encoding: "utf8", flag: "wx" });
        snapshotRelativePath = `canvas/snapshots/${filename}`;
        await this.pruneSnapshots();
      }
      return { project: structuredClone(project), snapshotRelativePath };
  }

  private async pruneSnapshots(): Promise<void> {
    const snapshots = (await readdir(this.snapshotsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^project_rev\d{6}_.*\.json$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const obsolete = snapshots.slice(0, Math.max(0, snapshots.length - MAX_PROJECT_SNAPSHOTS));
    for (const filename of obsolete) await rm(join(this.snapshotsRoot, filename));
  }

  private async pruneConflictDrafts(): Promise<void> {
    const drafts = (await readdir(this.conflictsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^conflict_rev\d{6}_.*\.json$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const obsolete = drafts.slice(0, Math.max(0, drafts.length - MAX_CONFLICT_DRAFTS));
    for (const filename of obsolete) await rm(join(this.conflictsRoot, filename));
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

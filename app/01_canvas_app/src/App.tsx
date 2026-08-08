import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  Arrow,
  Group,
  Image as KonvaImage,
  Layer,
  Line,
  Rect,
  Stage,
  Text,
  Transformer
} from "react-konva/lib/ReactKonvaCore";
import type Konva from "konva";
import "konva/lib/shapes/Image";
import "konva/lib/shapes/Arrow";
import "konva/lib/shapes/Line";
import "konva/lib/shapes/Rect";
import "konva/lib/shapes/Text";
import "konva/lib/shapes/Transformer";
import {
  cancelGenerationTask,
  adoptCanvasAsset,
  connectCanvasSession,
  createGenerationTask,
  downloadOriginalAsset,
  importCanvasAsset,
  listCanvasAssets,
  listPromptLibrary,
  readActiveProjectRequirements,
  readActiveGenerationTask,
  readCanvasAssetAsDataUrl,
  readCanvasAssetAsObjectUrl,
  readCanvasProject,
  readDeliveryTarget,
  readFileAsDataUrl,
  readGenerationResultAsDataUrl,
  readGenerationTask,
  saveGeneratedAsset,
  saveDeliveryTarget,
  savePromptLibraryItem,
  saveCanvasAssetDerivatives,
  saveCanvasProject,
  saveAnnotationExport,
  deletePromptLibraryItem,
  releaseAllCanvasAssetObjectUrls,
  updateActiveProjectRequirements,
  type ActiveProjectRequirements,
  type DeliveryTarget,
  type PromptLibraryItem
} from "./bridge-client";
import {
  isTerminalStatus,
  responseModeOf,
  type GenerationProvider,
  type GenerationStatus,
  type GenerationTask,
  type ImageRole
} from "@gpt-canvas/shared";
import { renderAnnotationExport } from "./annotation-export";
import {
  annotationIntersectsRect,
  annotationTypeLabel,
  normalizeRectangle,
  scaleAnnotation,
  type AnnotationState,
  type AnnotationType,
  type RectangleAnnotation
} from "./annotation-model";
import {
  OUTPUT_RATIOS,
  applyOutputRatio,
  arrangeVertically,
  buildCanvasRelation,
  coverCropForRenderedImage,
  fitImportedImage,
  normalizeImageFrames,
  placeChildToRight,
  placeImageContextToolbar,
  removeImageNode,
  type ImageNodeState,
  type OutputRatio
} from "./canvas-layout";
import { fitRect, fixedScreenScale, zoomAtPoint, type Viewport } from "./canvas-math";
import { canvasKeyboardAction, isMiddleMouseButton } from "./canvas-input";
import {
  MINIMUM_AUTOMATION_EXTENSION_VERSION,
  automationExtensionReady,
  automationExtensionVersion,
  shouldAutoReturnResults
} from "./canvas-automation";
import {
  buildGenerationTaskPreview,
  type GenerationMode,
  type ReferenceRole
} from "./task-preview";
import { createImageDerivatives, resizeImageToExactDimensions } from "./image-derivatives";
import {
  batchProgress,
  createCanvasBatchRun,
  createStageCanvasBatchRun,
  defaultWorkflowAction,
  nextQueuedBatchItem,
  updateBatchItem,
  WORKFLOW_ACTION_LABELS,
  type WorkflowAction
} from "./batch-queue";
import {
  buildCanvasProjectDocument,
  restoreCanvasProjectStructure,
  type CanvasBatchItem,
  type CanvasBatchRun,
  type CanvasWorkflowState,
  type HandoffTarget,
  type StandardHandoffRecord,
  type ViewpointStatusCard,
  type ViewpointStatus,
  type WorkflowStage
} from "./project-state";
import {
  createCanvasHistory,
  moveCanvasHistory,
  pushCanvasHistory,
  type CanvasHistorySnapshot,
  type CanvasHistoryState
} from "./canvas-history";
import { inferViewpointStatus } from "./workflow-status";
import { containsFolderFiles, naturalSortImportFiles } from "./folder-import";
import {
  FIXED_WORKFLOW_PROMPTS,
  fixedWorkflowPromptById,
  workflowStagePrompt,
  wrapPromptForAction
} from "./fixed-workflow-prompts";
import {
  FIXED_CUSTOM_GPT_STORAGE_KEY,
  generationTargetForCustomGpt,
  normalizeCustomGptUrl,
  resolveFixedCustomGptUrl
} from "./custom-gpt";
import {
  normalizeSelectionRect,
  selectNodesInRect,
  shouldStartMarqueeOnBackground
} from "./marquee-selection";
import {
  WORKBENCH_HEIGHT_STORAGE_KEY,
  WORKBENCH_WIDTH_STORAGE_KEY,
  clampWorkbenchHeight,
  clampWorkbenchWidth,
  resizedWorkbenchHeight,
  resizedWorkbenchWidth,
  storedWorkbenchHeight,
  storedWorkbenchWidth
} from "./workbench-panel";
import {
  alignedGlassFilename,
  aspectRatiosMatch,
  createCanvasTextCard,
  extractFinalPrompt,
  type CanvasTextCard
} from "./text-card";

type Tool = "select" | "marquee" | "text" | "arrow" | "freehand" | "rectangle";
type ServiceState = "connecting" | "connected" | "offline";
type SaveState = "loading" | "saving" | "saved" | "error";
type ImportLayout = "cascade" | "vertical";

const ATTACHMENT_ROLE_LABELS: Readonly<Record<ImageRole, string>> = {
  "structure-base": "唯一结构与构图依据",
  "edit-target": "编辑目标",
  "annotation-map": "带批注编辑图",
  "style-reference": "仅限视觉风格参考",
  "content-reference": "候选视角／内容参考",
  "d5-locked-view": "锁定的D5正式视角",
  "su-reference": "同方向SU模型截图",
  "region-mask": "旧版区域蒙版（仅兼容历史任务）",
  "delivery-candidate": "拟采用／待检查成果"
};

const STAGE_SELECTION_HINTS: Readonly<Record<WorkflowStage, string>> = {
  "stage-1": "选择1—3张候选视角，将在同一轮中对比并回写文字结论。",
  "stage-2": "选择锁定D5视角和对应SU截图，并先把D5图设为结构基准。",
  "stage-3": "每张底图单独处理；可先返回提示词卡，确认后再批量生成目标图。",
  "stage-4": "每张最终D5图单独整图生成；无需蒙版，返回同画幅完整效果图。",
  final: "逐张检查拟采用成果；如已指定结构基准，将同时进行结构对照。"
};

interface TextEditorState {
  annotationId: `annotation_${string}` | null;
  sourceAnnotationId: `annotation_${string}` | null;
  x: number;
  y: number;
  value: string;
}

interface Size {
  width: number;
  height: number;
}

interface MarqueeState {
  startX: number;
  startY: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LatestSaveState {
  projectName: string;
  revision: number;
  viewport: Viewport;
  nodes: ImageNodeState[];
  annotations: AnnotationState[];
  generationTask: GenerationTask | null;
  taskParentVersionId: `version_${string}` | null;
  workflow: CanvasWorkflowState;
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size>({ width: 1, height: 1 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, size };
}

const MAX_BROWSER_IMAGE_CACHE = 64;
const browserImageCache = new Map<string, Promise<HTMLImageElement>>();

function loadBrowserImage(src: string): Promise<HTMLImageElement> {
  const cached = browserImageCache.get(src);
  if (cached) return cached;
  const pending = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("画布显示图解码失败"));
    image.src = src;
  });
  browserImageCache.set(src, pending);
  if (browserImageCache.size > MAX_BROWSER_IMAGE_CACHE) {
    const oldest = browserImageCache.keys().next().value as string | undefined;
    if (oldest && oldest !== src) browserImageCache.delete(oldest);
  }
  pending.catch(() => browserImageCache.delete(src));
  return pending;
}

function useBrowserImage(src: string, enabled = true) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!enabled) {
      setImage(null);
      return;
    }
    let cancelled = false;
    void loadBrowserImage(src).then((next) => {
      if (!cancelled) setImage(next);
    }).catch(() => {
      if (!cancelled) setImage(null);
    });
    return () => { cancelled = true; };
  }, [enabled, src]);
  return image;
}

function ToolButton({ active, label, shortcut, onClick }: { active: boolean; label: string; shortcut: string; onClick: () => void }) {
  return (
    <button
      className="tool-button"
      data-active={active}
      aria-pressed={active}
      aria-keyshortcuts={shortcut}
      onClick={onClick}
      title={`${label} · ${shortcut}；再次点击或按 Esc 退出`}
    >
      <span className="tool-glyph" aria-hidden="true">{shortcut}</span>
      <span>{label}</span>
    </button>
  );
}

function RailCommandButton({
  glyph,
  label,
  disabled = false,
  onClick
}: {
  glyph: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="tool-button rail-command"
      disabled={disabled}
      onClick={onClick}
      title={label}
    >
      <span className="tool-glyph" aria-hidden="true">{glyph}</span>
      <span>{label}</span>
    </button>
  );
}

function ImageToolbarIcon({ kind }: { kind: "download" | "structure" | "style" }) {
  return (
    <span className="context-icon" aria-hidden="true">
      {kind === "download" ? (
        <svg viewBox="0 0 16 16">
          <path d="M8 2.25v7.5m-3-3 3 3 3-3M3 13.25h10" />
        </svg>
      ) : kind === "structure" ? (
        <svg viewBox="0 0 16 16">
          <rect x="2.5" y="2.5" width="11" height="11" rx=".5" />
          <path d="M2.5 6h11M6 2.5v11" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16">
          <path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4S1.5 8 1.5 8Z" />
          <circle cx="8" cy="8" r="1.75" />
        </svg>
      )}
    </span>
  );
}

function CanvasImageNode({
  node,
  selected,
  selectable,
  loadImage,
  roleLabel,
  workflowBadge,
  viewportScale,
  register,
  onSelect,
  onManipulationStart,
  onManipulationEnd,
  onChange
}: {
  node: ImageNodeState;
  selected: boolean;
  selectable: boolean;
  loadImage: boolean;
  roleLabel?: string;
  workflowBadge?: ImageWorkflowBadge;
  viewportScale: number;
  register: (instance: Konva.Group | null) => void;
  onSelect: () => void;
  onManipulationStart: () => void;
  onManipulationEnd: () => void;
  onChange: (next: ImageNodeState) => void;
}) {
  const image = useBrowserImage(node.src, loadImage);
  const roleScale = fixedScreenScale(viewportScale);
  const workflowScale = Math.min(roleScale, 2);
  const crop = coverCropForRenderedImage(
    image ? { width: image.naturalWidth, height: image.naturalHeight } : null,
    { width: node.sourceWidth, height: node.sourceHeight },
    { width: node.width, height: node.height }
  );
  const workflowColor = workflowBadge ? ({
    "not-started": "#716e68",
    "in-progress": "#276a9f",
    locked: "#35684d",
    rework: "#a05a19",
    blocked: "#8a2830"
  } satisfies Record<ViewpointStatus, string>)[workflowBadge.status] : "#716e68";

  return (
    <Group
      x={node.x}
      y={node.y}
      draggable={selectable}
      onClick={selectable ? onSelect : undefined}
      onTap={selectable ? onSelect : undefined}
      onDragStart={selectable ? onManipulationStart : undefined}
      onDragEnd={(event) => {
        onChange({ ...node, x: Math.round(event.target.x()), y: Math.round(event.target.y()) });
        onManipulationEnd();
      }}
    >
      <Group
        ref={register}
        width={node.width}
        height={node.height}
        onTransformStart={onManipulationStart}
        onTransformEnd={(event) => {
          const target = event.target;
          const scaleX = Math.abs(target.scaleX());
          const scaleY = Math.abs(target.scaleY());
          const offsetX = target.x();
          const offsetY = target.y();
          target.position({ x: 0, y: 0 });
          target.scale({ x: 1, y: 1 });
          onChange({
            ...node,
            x: Math.round(node.x + offsetX),
            y: Math.round(node.y + offsetY),
            width: Math.max(120, Math.round(node.width * scaleX)),
            height: Math.max(80, Math.round(node.height * scaleY))
          });
          onManipulationEnd();
        }}
      >
        <Rect
          width={node.width}
          height={node.height}
          fill="#ffffff"
          stroke={selected ? "#7a1820" : "#c8c8c8"}
          strokeWidth={selected ? 3 / viewportScale : 1}
          shadowColor="#000000"
          shadowBlur={selected ? 5 : 2}
          shadowOpacity={selected ? 0.12 : 0.05}
          shadowOffsetY={2}
        />
        {image ? (
          <KonvaImage
            image={image}
            width={node.width}
            height={node.height}
            crop={crop}
          />
        ) : (
          <Rect width={node.width} height={node.height} fill="#eeeeee" />
        )}
        {selected && (
          <Rect
            width={node.width}
            height={node.height}
            stroke="#7a1820"
            strokeWidth={3 / viewportScale}
            listening={false}
          />
        )}
      </Group>
      {roleLabel && (
        <Group
          y={-30 * roleScale}
          scaleX={roleScale}
          scaleY={roleScale}
          listening={false}
        >
          <Rect
            x={0}
            y={0}
            width={112}
            height={22}
            fill={roleLabel.startsWith("01") ? "#7a1820" : "#171717"}
            listening={false}
          />
          <Text
            x={8}
            y={6}
            width={96}
            text={roleLabel}
            fontFamily="Microsoft YaHei UI"
            fontSize={11}
            fill="#ffffff"
            listening={false}
          />
        </Group>
      )}
      {workflowBadge && (
        <Group
          x={Math.max(0, node.width - 174 * workflowScale)}
          y={-50 * workflowScale}
          scaleX={workflowScale}
          scaleY={workflowScale}
          listening={false}
        >
          <Rect width={174} height={42} fill="#f8f5ef" opacity={0.96} listening={false} />
          <Rect width={5} height={42} fill={workflowColor} listening={false} />
          <Text
            x={14}
            y={7}
            width={150}
            text={`${WORKFLOW_STAGE_SHORT_LABELS[workflowBadge.stage]} · ${VIEWPOINT_STATUS_LABELS[workflowBadge.status]}`}
            fontFamily="Microsoft YaHei UI"
            fontSize={11}
            fontStyle="bold"
            fill="#22201d"
            listening={false}
          />
          <Text
            x={14}
            y={24}
            width={150}
            text={`${workflowBadge.mode === "auto" ? "自动判断" : "人工覆盖"} · ${workflowBadge.relation}`}
            fontFamily="Microsoft YaHei UI"
            fontSize={9}
            fill="#625e57"
            listening={false}
          />
        </Group>
      )}
      <Text
        x={0}
        y={node.height + 10}
        width={Math.max(10, node.width - 88)}
        text={node.name}
        ellipsis
        wrap="none"
        fontFamily="Microsoft YaHei UI"
        fontSize={12}
        fill="#3f3f3f"
        listening={false}
      />
      <Text
        x={node.width - 80}
        y={node.height + 10}
        width={80}
        align="right"
        text={node.outputRatio === "free" ? "原始比例" : node.outputRatio}
        fontFamily="Bahnschrift"
        fontSize={11}
        fill="#7a1820"
        listening={false}
      />
    </Group>
  );
}

function CanvasAnnotation({
  annotation,
  selected,
  selectable,
  register,
  onSelect,
  onEdit,
  onChange
}: {
  annotation: AnnotationState;
  selected: boolean;
  selectable: boolean;
  register: (instance: Konva.Group | null) => void;
  onSelect: () => void;
  onEdit: () => void;
  onChange: (next: AnnotationState) => void;
}) {
  const common = {
    stroke: annotation.color,
    fill: annotation.color,
    strokeWidth: selected ? 4 : 3,
    hitStrokeWidth: 18
  };
  return (
    <Group
      ref={register}
      x={annotation.x}
      y={annotation.y}
      draggable={selectable}
      onClick={selectable ? onSelect : undefined}
      onTap={selectable ? onSelect : undefined}
      onDblClick={selectable && annotation.type === "text" ? onEdit : undefined}
      onDblTap={selectable && annotation.type === "text" ? onEdit : undefined}
      onDragEnd={(event) => onChange({
        ...annotation,
        x: Math.round(event.target.x()),
        y: Math.round(event.target.y())
      })}
      onTransformEnd={(event) => {
        const target = event.target;
        const next = scaleAnnotation(annotation, target.scaleX(), target.scaleY());
        target.scale({ x: 1, y: 1 });
        onChange({ ...next, x: Math.round(target.x()), y: Math.round(target.y()) });
      }}
    >
      {annotation.type === "rectangle" && (
        <Rect
          width={annotation.width}
          height={annotation.height}
          fillEnabled={false}
          {...common}
        />
      )}
      {annotation.type === "arrow" && (
        <Arrow
          points={annotation.points}
          pointerLength={18}
          pointerWidth={15}
          {...common}
        />
      )}
      {annotation.type === "freehand" && (
        <Line
          points={annotation.points}
          tension={0.2}
          lineCap="round"
          lineJoin="round"
          fillEnabled={false}
          {...common}
        />
      )}
      {annotation.type === "text" && (
        <Text
          text={annotation.text}
          width={annotation.width}
          fontFamily="Microsoft YaHei UI"
          fontSize={annotation.fontSize}
          fontStyle="bold"
          lineHeight={1.35}
          padding={7}
          fill={annotation.color}
          strokeEnabled={false}
        />
      )}
    </Group>
  );
}

function CanvasTextCardNode({
  card,
  viewport,
  selected,
  onSelect,
  onChange,
  onCommit,
  onUse,
  onCopy,
  onSave,
  onRemove
}: {
  card: CanvasTextCard;
  viewport: Viewport;
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<CanvasTextCard>) => void;
  onCommit: () => void;
  onUse: (text: string) => void;
  onCopy: (text: string) => void;
  onSave: (text: string) => void;
  onRemove: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chosenText = (preferSelection: boolean) => {
    const textarea = textareaRef.current;
    if (preferSelection && textarea && textarea.selectionEnd > textarea.selectionStart) {
      return card.text.slice(textarea.selectionStart, textarea.selectionEnd).trim();
    }
    return card.kind === "prompt" ? extractFinalPrompt(card.text) : card.text.trim();
  };
  const beginDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button,input,textarea")) return;
    event.preventDefault();
    onSelect();
    const startX = event.clientX;
    const startY = event.clientY;
    const originalX = card.x;
    const originalY = card.y;
    const move = (moveEvent: PointerEvent) => onChange({
      x: Math.round(originalX + (moveEvent.clientX - startX) / viewport.scale),
      y: Math.round(originalY + (moveEvent.clientY - startY) / viewport.scale)
    });
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      onCommit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  return (
    <article
      className="canvas-text-card"
      data-kind={card.kind}
      data-selected={selected || undefined}
      style={{
        left: viewport.x + card.x * viewport.scale,
        top: viewport.y + card.y * viewport.scale,
        width: card.width,
        height: card.height,
        transform: `scale(${viewport.scale})`
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      <header onPointerDown={beginDrag} title="拖动文字卡">
        <span>{card.kind === "prompt" ? "PROMPT" : "REVIEW"}</span>
        <input
          value={card.title}
          maxLength={120}
          aria-label="文字卡标题"
          onChange={(event) => onChange({ title: event.target.value })}
          onBlur={onCommit}
        />
        <button type="button" title="从画布移除文字卡" onClick={onRemove}>×</button>
      </header>
      <textarea
        ref={textareaRef}
        value={card.text}
        aria-label={`${card.title}内容`}
        spellCheck={false}
        onChange={(event) => onChange({ text: event.target.value })}
        onBlur={onCommit}
      />
      <footer>
        <button type="button" onClick={() => onUse(chosenText(true))}>使用选中</button>
        <button type="button" className="text-card-primary" onClick={() => onUse(chosenText(false))}>用于下一步</button>
        <button type="button" onClick={() => onCopy(chosenText(false))}>复制</button>
        <button type="button" onClick={() => onSave(chosenText(false))}>存入库</button>
      </footer>
    </article>
  );
}

const TASK_STATUS_LABELS: Record<GenerationStatus, string> = {
  draft: "草稿",
  queued: "等待扩展领取",
  "opening-chat": "正在打开生成页",
  uploading: "正在上传附件",
  "ready-to-submit": "正在自动提交",
  submitted: "已自动提交",
  generating: "生成中",
  collecting: "正在收集结果",
  returning: "正在回传画布",
  completed: "任务已完成",
  "needs-user": "需要人工处理",
  failed: "任务失败",
  cancelled: "任务已取消"
};

const PROVIDER_LABELS: Record<GenerationProvider, string> = {
  chatgpt: "ChatGPT",
  "google-flow": "Google Flow"
};

const WORKFLOW_STAGE_LABELS: Record<WorkflowStage, string> = {
  "stage-1": "阶段一｜相机与构图",
  "stage-2": "阶段二｜SU可见细节",
  "stage-3": "阶段三｜D5场景深化",
  "stage-4": "阶段四｜玻璃与内透",
  final: "最终成果"
};

const VIEWPOINT_STATUS_LABELS: Record<ViewpointStatus, string> = {
  "not-started": "未开始",
  "in-progress": "进行中",
  locked: "已锁定",
  rework: "返回修改",
  blocked: "缺少素材"
};

const HANDOFF_TARGET_LABELS: Record<HandoffTarget, string> = {
  su: "SketchUp",
  d5: "D5",
  gpt: "GPT",
  codex: "Codex",
  photoshop: "Photoshop",
  review: "人工复核"
};

const WORKFLOW_STAGE_SHORT_LABELS: Record<WorkflowStage, string> = {
  "stage-1": "阶段一",
  "stage-2": "阶段二",
  "stage-3": "阶段三",
  "stage-4": "阶段四",
  final: "最终成果"
};

const WORKFLOW_STAGE_CONTROL_LABELS: Record<WorkflowStage, string> = {
  "stage-1": "阶段一｜相机构图",
  "stage-2": "阶段二｜SU细节",
  "stage-3": "阶段三｜D5深化",
  "stage-4": "阶段四｜玻璃内透",
  final: "最终成果"
};

interface ImageWorkflowBadge {
  stage: WorkflowStage;
  status: ViewpointStatus;
  mode: "auto" | "manual";
  relation: "底图" | "候选" | "采用";
}

function defaultViewpointName(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "").trim();
  return stem.replace(/_(AO|MaterialID|Transparent|SkyMask|Z-Depth|Reflection)$/i, "") || "未命名视角";
}

function handoffMarkdown(
  record: StandardHandoffRecord,
  versionPaths: Map<string, string>
): string {
  const sourcePath = record.sourceVersionId ? versionPaths.get(record.sourceVersionId) : null;
  const selectedPath = record.selectedVersionId ? versionPaths.get(record.selectedVersionId) : null;
  return [
    `# ${record.viewpointName}｜标准交接记录`,
    "",
    `- 记录时间：${new Date(record.createdAt).toLocaleString("zh-CN", { hour12: false })}`,
    `- 当前阶段：${WORKFLOW_STAGE_LABELS[record.stage]}`,
    `- 当前状态：${VIEWPOINT_STATUS_LABELS[record.status]}`,
    `- 下一环节：${HANDOFF_TARGET_LABELS[record.target]}`,
    `- D5批次：${record.d5Batch || "未指定"}`,
    `- 结构/底图：${sourcePath ?? record.sourceVersionId ?? "未指定"}`,
    `- 采用成果：${selectedPath ?? record.selectedVersionId ?? "未指定"}`,
    `- 对应任务：${record.taskId ?? "无"}`,
    "",
    "## 本轮结论",
    record.conclusion || "暂无结论",
    "",
    "## 下一步",
    record.nextAction || "待确认"
  ].join("\n");
}

function readFixedCustomGptUrl(): string | null {
  try {
    return window.localStorage.getItem(FIXED_CUSTOM_GPT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistFixedCustomGptUrl(value: string): void {
  try {
    window.localStorage.setItem(FIXED_CUSTOM_GPT_STORAGE_KEY, value);
  } catch {
    // Project state still preserves the target when browser storage is unavailable.
  }
}

function readSavedWorkbenchHeight(): number | null {
  try {
    return storedWorkbenchHeight(
      window.localStorage.getItem(WORKBENCH_HEIGHT_STORAGE_KEY),
      window.innerHeight
    );
  } catch {
    return null;
  }
}

function persistWorkbenchHeight(value: number): void {
  try {
    window.localStorage.setItem(WORKBENCH_HEIGHT_STORAGE_KEY, String(value));
  } catch {
    // The current session still keeps the resized height when browser storage is unavailable.
  }
}

function readSavedWorkbenchWidth(): number | null {
  try {
    return storedWorkbenchWidth(
      window.localStorage.getItem(WORKBENCH_WIDTH_STORAGE_KEY),
      window.innerWidth
    );
  } catch {
    return null;
  }
}

function persistWorkbenchWidth(value: number): void {
  try {
    window.localStorage.setItem(WORKBENCH_WIDTH_STORAGE_KEY, String(value));
  } catch {
    // The current session still keeps the resized width when browser storage is unavailable.
  }
}

export function App({ projectName }: { projectId: string; projectName: string }) {
  const { ref: canvasRef, size } = useElementSize<HTMLDivElement>();
  const [tool, setTool] = useState<Tool>("select");
  const [nodes, setNodes] = useState<ImageNodeState[]>([]);
  const [annotations, setAnnotations] = useState<AnnotationState[]>([]);
  const [textCards, setTextCards] = useState<CanvasTextCard[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [selectedTextCardId, setSelectedTextCardId] = useState<string | null>(null);
  const [drawingId, setDrawingId] = useState<string | null>(null);
  const [textEditor, setTextEditor] = useState<TextEditorState | null>(null);
  const [middlePanning, setMiddlePanning] = useState(false);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 72, y: 54, scale: 0.74 });
  const [serviceState, setServiceState] = useState<ServiceState>("connecting");
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deliveryTarget, setDeliveryTarget] = useState<DeliveryTarget | null>(null);
  const [deliveryTargetDraft, setDeliveryTargetDraft] = useState("");
  const [savingDeliveryTarget, setSavingDeliveryTarget] = useState(false);
  const [adoptingToProject, setAdoptingToProject] = useState(false);
  const [downloadingOriginal, setDownloadingOriginal] = useState(false);
  const [manipulatingNodeId, setManipulatingNodeId] = useState<string | null>(null);
  const [notice, setNotice] = useState("将 PNG、JPEG 或 WebP 拖入画布，原图会复制到项目资产目录。");
  const [revision, setRevision] = useState(1);
  const [structureBaseId, setStructureBaseId] = useState<string | null>(null);
  const [styleReferenceId, setStyleReferenceId] = useState<string | null>(null);
  const [taskInstruction, setTaskInstruction] = useState("");
  const [generationMode, setGenerationMode] = useState<GenerationMode>("reference-edit");
  const [workflowAction, setWorkflowAction] = useState<WorkflowAction>("analyze");
  const generationProvider: GenerationProvider = "chatgpt";
  const [viewpoints, setViewpoints] = useState<ViewpointStatusCard[]>([]);
  const [handoffs, setHandoffs] = useState<StandardHandoffRecord[]>([]);
  const [batchRun, setBatchRun] = useState<CanvasBatchRun | null>(null);
  const [batchSourceVersionIds, setBatchSourceVersionIds] = useState<`version_${string}`[]>([]);
  const [customGptUrl, setCustomGptUrl] = useState(() => resolveFixedCustomGptUrl(readFixedCustomGptUrl(), ""));
  const [customGptEnabled, setCustomGptEnabled] = useState(false);
  const [customGptDraft, setCustomGptDraft] = useState(() => resolveFixedCustomGptUrl(readFixedCustomGptUrl(), ""));
  const [editingCustomGptTarget, setEditingCustomGptTarget] = useState(false);
  const [bulkStage, setBulkStage] = useState<WorkflowStage>("stage-1");
  const [activeViewpointId, setActiveViewpointId] = useState<`viewpoint_${string}` | null>(null);
  const [handoffTarget, setHandoffTarget] = useState<HandoffTarget>("d5");
  const [promptLibrary, setPromptLibrary] = useState<PromptLibraryItem[]>([]);
  const [projectRequirements, setProjectRequirements] = useState<ActiveProjectRequirements | null>(null);
  const [editingProjectRequirements, setEditingProjectRequirements] = useState(false);
  const [projectRequirementsDraft, setProjectRequirementsDraft] = useState("");
  const [savingProjectRequirements, setSavingProjectRequirements] = useState(false);
  const [selectedPromptId, setSelectedPromptId] = useState("");
  const [selectedFixedPromptId, setSelectedFixedPromptId] = useState("");
  const [promptTitle, setPromptTitle] = useState("");
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [workbenchPanel, setWorkbenchPanel] = useState<"batch" | "prompts" | "preview" | "delivery" | null>(null);
  const [generationTask, setGenerationTask] = useState<GenerationTask | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [cancellingTask, setCancellingTask] = useState(false);
  const [returningResults, setReturningResults] = useState(false);
  const [automationReady, setAutomationReady] = useState(
    () => {
      const root = document.documentElement;
      const status = root.getAttribute("data-gpt-canvas-automation-status");
      const version = automationExtensionVersion(
        root.getAttribute("data-gpt-canvas-extension-version"),
        root.getAttribute("data-gpt-canvas-automation-message")
      );
      return automationExtensionReady(status, version);
    }
  );
  const [taskParentVersionId, setTaskParentVersionId] = useState<`version_${string}` | null>(null);
  const [returnedResultIds, setReturnedResultIds] = useState<string[]>([]);
  const [projectLoaded, setProjectLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [historyVersion, setHistoryVersion] = useState(0);
  const [workbenchHeight, setWorkbenchHeight] = useState<number | null>(readSavedWorkbenchHeight);
  const [workbenchWidth, setWorkbenchWidth] = useState<number | null>(readSavedWorkbenchWidth);
  const [resizingWorkbench, setResizingWorkbench] = useState(false);
  const stageRef = useRef<Konva.Stage>(null);
  const middlePanningRef = useRef(false);
  const transformerRef = useRef<Konva.Transformer>(null);
  const annotationTransformerRef = useRef<Konva.Transformer>(null);
  const textEditorRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const nodeRefs = useRef(new Map<string, Konva.Group>());
  const annotationRefs = useRef(new Map<string, Konva.Group>());
  const returnInFlightRef = useRef(false);
  const automationRunTaskRef = useRef<string | null>(null);
  const batchStartInFlightRef = useRef<string | null>(null);
  const projectIdRef = useRef<`project_${string}`>(`project_${crypto.randomUUID()}`);
  const projectCreatedAtRef = useRef(new Date().toISOString());
  const lastSavedRevisionRef = useRef(-1);
  const snapshottedTaskRef = useRef<string | null>(null);
  const saveInFlightRef = useRef<Promise<void> | null>(null);
  const saveRequestedRef = useRef(false);
  const latestSaveStateRef = useRef<LatestSaveState>({
    projectName,
    revision,
    viewport,
    nodes,
    annotations,
    generationTask,
    taskParentVersionId,
    workflow: { activeViewpointId, viewpoints, handoffs, batchRun, customGptUrl, customGptEnabled, textCards }
  });
  const historyRef = useRef<CanvasHistoryState | null>(null);
  const applyingHistoryRef = useRef(false);

  latestSaveStateRef.current = {
    projectName,
    revision,
    viewport,
    nodes,
    annotations,
    generationTask,
    taskParentVersionId,
    workflow: { activeViewpointId, viewpoints, handoffs, batchRun, customGptUrl, customGptEnabled, textCards }
  };

  const beginWorkbenchResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const panel = inspectorRef.current;
    if (!panel) return;

    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startPointerY = event.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    handle.setPointerCapture(pointerId);
    setResizingWorkbench(true);

    const heightAt = (clientY: number) => resizedWorkbenchHeight(
      startHeight,
      startPointerY,
      clientY,
      window.innerHeight
    );
    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      setWorkbenchHeight(heightAt(moveEvent.clientY));
    };
    const finishResize = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== pointerId) return;
      const nextHeight = heightAt(finishEvent.clientY);
      setWorkbenchHeight(nextHeight);
      persistWorkbenchHeight(nextHeight);
      setResizingWorkbench(false);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      handle.blur();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
  };

  const resizeWorkbenchFromKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowUp", "ArrowDown", "Home"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") {
      setWorkbenchHeight(null);
      try {
        window.localStorage.removeItem(WORKBENCH_HEIGHT_STORAGE_KEY);
      } catch {
        // Keep the automatic height for this session.
      }
      return;
    }
    const currentHeight = workbenchHeight ?? inspectorRef.current?.getBoundingClientRect().height ?? 360;
    const direction = event.key === "ArrowUp" ? 1 : -1;
    const step = event.shiftKey ? 48 : 16;
    const nextHeight = clampWorkbenchHeight(currentHeight + direction * step, window.innerHeight);
    setWorkbenchHeight(nextHeight);
    persistWorkbenchHeight(nextHeight);
  };

  const beginWorkbenchWidthResize = (
    event: ReactPointerEvent<HTMLDivElement>,
    side: "left" | "right"
  ) => {
    if (event.button !== 0) return;
    const panel = inspectorRef.current;
    if (!panel) return;

    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startPointerX = event.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    handle.setPointerCapture(pointerId);
    setResizingWorkbench(true);

    const widthAt = (clientX: number) => resizedWorkbenchWidth(
      startWidth,
      startPointerX,
      clientX,
      side,
      window.innerWidth
    );
    const onPointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      setWorkbenchWidth(widthAt(moveEvent.clientX));
    };
    const finishResize = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== pointerId) return;
      const nextWidth = widthAt(finishEvent.clientX);
      setWorkbenchWidth(nextWidth);
      persistWorkbenchWidth(nextWidth);
      setResizingWorkbench(false);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      handle.blur();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
  };

  const resizeWorkbenchWidthFromKeyboard = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    side: "left" | "right"
  ) => {
    if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") {
      setWorkbenchWidth(null);
      try {
        window.localStorage.removeItem(WORKBENCH_WIDTH_STORAGE_KEY);
      } catch {
        // Keep the automatic width for this session.
      }
      return;
    }
    const currentWidth = workbenchWidth ?? inspectorRef.current?.getBoundingClientRect().width ?? 960;
    const expands = side === "left" ? event.key === "ArrowLeft" : event.key === "ArrowRight";
    const step = event.shiftKey ? 96 : 32;
    const nextWidth = clampWorkbenchWidth(currentWidth + (expands ? step : -step), window.innerWidth);
    setWorkbenchWidth(nextWidth);
    persistWorkbenchWidth(nextWidth);
  };

  useEffect(() => () => {
    browserImageCache.clear();
    releaseAllCanvasAssetObjectUrls();
  }, []);

  const selectedNode = nodes.find((node) => node.id === selectedId) ?? null;
  const selectedBatchNodes = useMemo(() => nodes.filter((node) => selectedNodeIds.includes(node.id)), [nodes, selectedNodeIds]);
  const normalizedCustomGptUrl = useMemo(() => normalizeCustomGptUrl(customGptUrl), [customGptUrl]);
  const activeTargetChatUrl = customGptEnabled ? normalizedCustomGptUrl ?? "" : "";
  const generationTargetReady = !customGptEnabled || Boolean(normalizedCustomGptUrl);
  const commitCustomGptTarget = useCallback(() => {
    const normalized = normalizeCustomGptUrl(customGptDraft);
    if (!normalized) {
      setNotice("专属 GPT 地址无效，请粘贴以 https://chatgpt.com/g/g- 开头的 GPT 首页地址。");
      return;
    }
    setCustomGptUrl(normalized);
    setCustomGptEnabled(true);
    setCustomGptDraft(normalized);
    setEditingCustomGptTarget(false);
    persistFixedCustomGptUrl(normalized);
    setRevision((current) => current + 1);
    setNotice("可选专属 GPT 已保存并启用；可随时切回普通 GPT。");
  }, [customGptDraft]);
  const selectedAnnotation = annotations.find((annotation) => annotation.id === selectedAnnotationId) ?? null;
  const structureBase = nodes.find((node) => node.id === structureBaseId) ?? null;
  const styleReference = nodes.find((node) => node.id === styleReferenceId) ?? null;
  const activeViewpoint = viewpoints.find((viewpoint) => viewpoint.id === activeViewpointId) ?? null;
  const activeViewpointHandoffs = activeViewpoint
    ? handoffs.filter((handoff) => handoff.viewpointId === activeViewpoint.id)
    : [];
  const activeViewpointSource = activeViewpoint?.sourceVersionId
    ? nodes.find((node) => node.versionId === activeViewpoint.sourceVersionId) ?? null
    : null;
  const activeViewpointResult = activeViewpoint?.selectedVersionId
    ? nodes.find((node) => node.versionId === activeViewpoint.selectedVersionId) ?? null
    : null;
  const viewpointInferences = useMemo(() => new Map(viewpoints.map((viewpoint) => [
    viewpoint.id,
    inferViewpointStatus(viewpoint, nodes, generationTask, taskParentVersionId)
  ])), [generationTask, nodes, taskParentVersionId, viewpoints]);
  const activeViewpointInference = activeViewpoint
    ? viewpointInferences.get(activeViewpoint.id) ?? inferViewpointStatus(
        activeViewpoint,
        nodes,
        generationTask,
        taskParentVersionId
      )
    : null;
  const selectedWorkflowViewpoint = selectedNode
    ? viewpoints.find((viewpoint) => (
        viewpoint.sourceVersionId === (selectedNode.parentVersionId ?? selectedNode.versionId)
        || viewpoint.selectedVersionId === selectedNode.versionId
      )) ?? null
    : null;
  const selectedWorkflowInference = selectedWorkflowViewpoint
    ? viewpointInferences.get(selectedWorkflowViewpoint.id) ?? null
    : null;
  const structureAnnotations = useMemo(() => structureBase
    ? annotations.filter((annotation) => annotationIntersectsRect(annotation, {
      x: structureBase.x,
      y: structureBase.y,
      width: structureBase.width,
      height: structureBase.height
    }))
    : [], [annotations, structureBase]);
  const generationActive = Boolean(generationTask && !isTerminalStatus(generationTask.status));
  const generationResultsPending = Boolean(
    generationTask?.status === "completed"
    && generationTask.results.some((result) => !returnedResultIds.includes(result.id))
  );
  const currentBatchProgress = useMemo(() => batchProgress(batchRun), [batchRun]);
  const taskPreview = useMemo(
    () => buildGenerationTaskPreview(
      taskInstruction,
      structureBase,
      styleReference,
      projectRequirements?.generationContext ?? "",
      generationMode,
      structureAnnotations.length > 0
    ),
    [
      generationMode,
      projectRequirements?.generationContext,
      structureAnnotations.length,
      structureBase,
      styleReference,
      taskInstruction
    ]
  );
  const textEditorPosition = useMemo(() => {
    if (!textEditor) return null;
    const preferredLeft = viewport.x + textEditor.x * viewport.scale;
    const preferredTop = viewport.y + textEditor.y * viewport.scale;
    return {
      left: Math.max(12, Math.min(preferredLeft, Math.max(12, size.width - 304))),
      top: Math.max(12, Math.min(preferredTop, Math.max(12, size.height - 152)))
    };
  }, [size.height, size.width, textEditor, viewport]);
  const imageToolbarPlacement = useMemo(() => {
    if (
      !selectedNode
      || selectedAnnotationId
      || tool !== "select"
      || selectedNodeIds.length > 1
      || middlePanning
      || manipulatingNodeId === selectedNode.id
    ) {
      return null;
    }
    return placeImageContextToolbar(selectedNode, viewport, size, {
      minWidth: 620,
      maxWidth: 760,
      height: 62
    });
  }, [
    manipulatingNodeId,
    middlePanning,
    selectedAnnotationId,
    selectedNodeIds.length,
    selectedNode,
    size,
    tool,
    viewport
  ]);
  const beginMiddlePan = useCallback((event: Konva.KonvaEventObject<MouseEvent>) => {
    if (!isMiddleMouseButton(event.evt.button)) return false;
    event.evt.preventDefault();
    const stage = event.target.getStage();
    if (!stage) return true;
    middlePanningRef.current = true;
    setMiddlePanning(true);
    stage.draggable(true);
    stage.startDrag();
    return true;
  }, []);

  const endMiddlePan = useCallback(() => {
    if (!middlePanningRef.current) return false;
    const stage = stageRef.current;
    middlePanningRef.current = false;
    setMiddlePanning(false);
    if (stage) {
      setViewport((current) => ({ ...current, x: stage.x(), y: stage.y() }));
      stage.stopDrag();
      stage.draggable(false);
    }
    return true;
  }, []);

  const connectService = useCallback(async () => {
    setServiceState("connecting");
    try {
      await connectCanvasSession();
      setServiceState("connected");
      setGenerationTask(await readActiveGenerationTask());
    } catch {
      setServiceState("offline");
    }
  }, []);

  useEffect(() => {
    void connectService();
  }, [connectService]);

  useEffect(() => {
    if (serviceState !== "connected") return;
    void Promise.all([
      listPromptLibrary().then(setPromptLibrary),
      readActiveProjectRequirements().then(setProjectRequirements),
      readDeliveryTarget().then((target) => {
        setDeliveryTarget(target);
        setDeliveryTargetDraft(target?.aiDirectory ?? "");
      })
    ]).catch((error: unknown) => (
      setNotice(error instanceof Error ? error.message : "项目上下文读取失败")
    ));
  }, [serviceState]);

  useEffect(() => {
    const onAutomationStatus = () => {
      const status = document.documentElement.getAttribute("data-gpt-canvas-automation-status");
      const message = document.documentElement.getAttribute("data-gpt-canvas-automation-message");
      const version = automationExtensionVersion(
        document.documentElement.getAttribute("data-gpt-canvas-extension-version"),
        message
      );
      const ready = automationExtensionReady(status, version);
      setAutomationReady(ready);
      if (status === "error") automationRunTaskRef.current = null;
      if ((status === "ready" || status === "started") && !ready) {
        setNotice(`浏览器扩展版本 ${version ?? "未知"} 过旧，请在 Chrome 扩展管理页重载到 ${MINIMUM_AUTOMATION_EXTENSION_VERSION}`);
      } else if (message) setNotice(message);
    };
    const onTaskCompleted = () => {
      const taskId = document.documentElement.getAttribute("data-gpt-canvas-completed-task-id");
      if (!taskId || !/^task_[A-Za-z0-9_-]+$/.test(taskId)) return;
      void readGenerationTask(taskId)
        .then(setGenerationTask)
        .catch((error: unknown) => setNotice(error instanceof Error ? error.message : "自动读取生成结果失败"));
    };
    window.addEventListener("gpt-canvas-automation-status", onAutomationStatus);
    window.addEventListener("gpt-canvas-task-completed", onTaskCompleted);
    onAutomationStatus();
    return () => {
      window.removeEventListener("gpt-canvas-automation-status", onAutomationStatus);
      window.removeEventListener("gpt-canvas-task-completed", onTaskCompleted);
    };
  }, []);

  useEffect(() => {
    if (!automationReady || !generationTask || isTerminalStatus(generationTask.status)) return;
    if (automationRunTaskRef.current === generationTask.id) return;
    automationRunTaskRef.current = generationTask.id;
    document.documentElement.setAttribute("data-gpt-canvas-task-id", generationTask.id);
    window.dispatchEvent(new Event("gpt-canvas-run-task"));
    setNotice(`任务 ${generationTask.id} 已恢复，正在自动续跑。`);
  }, [automationReady, generationTask?.id, generationTask?.status]);

  useEffect(() => {
    if (serviceState !== "connected" || projectLoaded) return;
    let cancelled = false;
    void (async () => {
      try {
        const project = await readCanvasProject();
        if (cancelled) return;
        if (project) {
          const restored = restoreCanvasProjectStructure(project);
          const assetMetadata = new Map(project.assets.map((asset) => [asset.id, asset]));
          const displayCache = new Map<string, Promise<string>>();
          const restoredNodes = await Promise.all(restored.imageNodes.map(async (node) => {
            const asset = assetMetadata.get(node.assetId);
            let source = displayCache.get(node.assetId);
            if (!source) {
              source = readCanvasAssetAsObjectUrl(node.assetId, asset?.display ? "display" : "original");
              displayCache.set(node.assetId, source);
            }
            return { ...node, src: await source };
          }));
          if (cancelled) return;
          projectIdRef.current = project.projectId;
          projectCreatedAtRef.current = project.createdAt;
          lastSavedRevisionRef.current = project.revision;
          setNodes(restoredNodes);
          setAnnotations(restored.annotations);
          setTextCards(restored.workflow.textCards);
          setViewport(restored.viewport);
          setTaskParentVersionId(restored.taskParentVersionId);
          setViewpoints(restored.workflow.viewpoints);
          setHandoffs(restored.workflow.handoffs);
          setActiveViewpointId(restored.workflow.activeViewpointId);
          setBatchRun(restored.workflow.batchRun);
          setBatchSourceVersionIds(restored.workflow.batchRun?.items.map((item) => item.sourceVersionId) ?? []);
          const fixedCustomGptUrl = resolveFixedCustomGptUrl(
            readFixedCustomGptUrl(),
            restored.workflow.customGptUrl
          );
          setCustomGptUrl(fixedCustomGptUrl);
          setCustomGptDraft(fixedCustomGptUrl);
          setCustomGptEnabled(restored.workflow.customGptEnabled && Boolean(fixedCustomGptUrl));
          if (fixedCustomGptUrl) persistFixedCustomGptUrl(fixedCustomGptUrl);
          setRevision(project.revision);
          setSelectedId(restoredNodes[0]?.id ?? null);
          setNotice(`项目已恢复：${restoredNodes.length} 个图片节点、${restored.workflow.textCards.length} 张文字卡、${restored.annotations.length} 条批注。`);
        }
        setProjectLoaded(true);
        setSaveState("saved");
      } catch (error) {
        if (cancelled) return;
        setProjectLoaded(true);
        setSaveState("error");
        setNotice(error instanceof Error ? `项目恢复失败：${error.message}` : "项目恢复失败");
      }
    })();
    return () => { cancelled = true; };
  }, [projectLoaded, serviceState]);

  const saveProjectNow = useCallback(async () => {
    if (saveInFlightRef.current) {
      saveRequestedRef.current = true;
      return saveInFlightRef.current;
    }
    const run = async () => {
      do {
        saveRequestedRef.current = false;
        const snapshot = latestSaveStateRef.current;
        setSaveState("saving");
        try {
          const assets = await listCanvasAssets();
          const forceSnapshot = Boolean(
            snapshot.generationTask?.status === "completed"
            && snapshot.generationTask.id !== snapshottedTaskRef.current
          );
          const project = buildCanvasProjectDocument({
            projectId: projectIdRef.current,
            title: snapshot.projectName,
            createdAt: projectCreatedAtRef.current,
            revision: snapshot.revision,
            viewport: snapshot.viewport,
            nodes: snapshot.nodes,
            annotations: snapshot.annotations,
            assets,
            generationTask: snapshot.generationTask,
            taskParentVersionId: snapshot.taskParentVersionId,
            workflow: snapshot.workflow
          });
          await saveCanvasProject(project, forceSnapshot);
          lastSavedRevisionRef.current = Math.max(lastSavedRevisionRef.current, snapshot.revision);
          if (forceSnapshot && snapshot.generationTask) {
            snapshottedTaskRef.current = snapshot.generationTask.id;
          }
          if (latestSaveStateRef.current.revision > snapshot.revision) {
            saveRequestedRef.current = true;
          }
        } catch (error) {
          setSaveState("error");
          setNotice(error instanceof Error ? `自动保存失败：${error.message}` : "自动保存失败");
          return;
        }
      } while (saveRequestedRef.current);
      setSaveState("saved");
    };
    const pending = run().finally(() => {
      saveInFlightRef.current = null;
    });
    saveInFlightRef.current = pending;
    return pending;
  }, []);

  useEffect(() => {
    if (serviceState !== "connected" || !projectLoaded) return;
    const timer = window.setTimeout(() => {
      saveRequestedRef.current = true;
      void saveProjectNow();
    }, 350);
    return () => window.clearTimeout(timer);
  }, [
    annotations,
    generationTask?.id,
    generationTask?.status,
    activeViewpointId,
    batchRun,
    customGptEnabled,
    customGptUrl,
    handoffs,
    nodes,
    projectLoaded,
    revision,
    saveProjectNow,
    serviceState,
    taskParentVersionId,
    textCards,
    viewport,
    viewpoints
  ]);

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState !== "hidden" || !projectLoaded || serviceState !== "connected") return;
      saveRequestedRef.current = true;
      void saveProjectNow();
    };
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!projectLoaded || latestSaveStateRef.current.revision <= lastSavedRevisionRef.current) return;
      saveRequestedRef.current = true;
      void saveProjectNow();
      event.preventDefault();
      event.returnValue = "";
    };
    document.addEventListener("visibilitychange", flushWhenHidden);
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("beforeunload", warnBeforeUnload);
    };
  }, [projectLoaded, saveProjectNow, serviceState]);

  useEffect(() => {
    if (!projectLoaded) return;
    if (applyingHistoryRef.current) {
      applyingHistoryRef.current = false;
      return;
    }
    const snapshot: CanvasHistorySnapshot = {
      nodes,
      annotations,
      textCards,
      structureBaseId,
      styleReferenceId,
      taskInstruction
    };
    historyRef.current = historyRef.current
      ? pushCanvasHistory(historyRef.current, snapshot)
      : createCanvasHistory(snapshot);
    setHistoryVersion((current) => current + 1);
  }, [projectLoaded, revision]);

  const applyHistory = useCallback((direction: -1 | 1) => {
    const history = historyRef.current;
    if (!history) return;
    const moved = moveCanvasHistory(history, direction);
    if (!moved.snapshot) return;
    historyRef.current = moved.state;
    applyingHistoryRef.current = true;
    setNodes(moved.snapshot.nodes);
    setAnnotations(moved.snapshot.annotations);
    setTextCards(moved.snapshot.textCards);
    setStructureBaseId(moved.snapshot.structureBaseId);
    setStyleReferenceId(moved.snapshot.styleReferenceId);
    setTaskInstruction(moved.snapshot.taskInstruction);
    setSelectedId(null);
    setSelectedAnnotationId(null);
    setSelectedTextCardId(null);
    setRevision((current) => current + 1);
    setHistoryVersion((current) => current + 1);
    setNotice(direction === -1 ? "已撤销上一步画布修改。" : "已重做画布修改。");
  }, []);

  const history = historyRef.current;
  const canUndo = Boolean(history && history.cursor > 0);
  const canRedo = Boolean(history && history.cursor < history.entries.length - 1);
  void historyVersion;

  useEffect(() => {
    if (!generationTask || isTerminalStatus(generationTask.status)) return;
    let failures = 0;
    const timer = window.setInterval(() => {
      void readGenerationTask(generationTask.id)
        .then((task) => {
          failures = 0;
          setGenerationTask(task);
        })
        .catch((error: unknown) => {
          failures += 1;
          if (failures < 2) return;
          setServiceState("offline");
          setNotice(error instanceof Error
            ? `任务状态读取失败：${error.message}`
            : "任务状态读取失败，请重新连接本地服务。");
        });
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [generationTask?.id, generationTask?.status]);

  useEffect(() => {
    const transformer = transformerRef.current;
    const selected = selectedId && !selectedAnnotationId && selectedNodeIds.length <= 1
      ? nodeRefs.current.get(selectedId)
      : undefined;
    transformer?.nodes(selected ? [selected] : []);
    transformer?.getLayer()?.batchDraw();
  }, [nodes, selectedAnnotationId, selectedId, selectedNodeIds.length, tool]);

  useEffect(() => {
    const transformer = annotationTransformerRef.current;
    const selected = selectedAnnotationId ? annotationRefs.current.get(selectedAnnotationId) : undefined;
    transformer?.nodes(selected ? [selected] : []);
    transformer?.getLayer()?.batchDraw();
  }, [annotations, selectedAnnotationId, tool]);

  useEffect(() => {
    if (!textEditor) return;
    const frame = window.requestAnimationFrame(() => {
      textEditorRef.current?.focus();
      textEditorRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [textEditor?.annotationId, textEditor?.x, textEditor?.y]);

  const updateNode = useCallback((next: ImageNodeState) => {
    setNodes((current) => current.map((node) => node.id === next.id ? next : node));
    setRevision((current) => current + 1);
  }, []);

  const updateAnnotation = useCallback((next: AnnotationState) => {
    setAnnotations((current) => current.map((annotation) => annotation.id === next.id ? next : annotation));
    setRevision((current) => current + 1);
  }, []);

  const canvasPoint = useCallback(() => {
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer) return null;
    return {
      x: (pointer.x - viewport.x) / viewport.scale,
      y: (pointer.y - viewport.y) / viewport.scale
    };
  }, [viewport]);

  const beginMarquee = useCallback(() => {
    const point = canvasPoint();
    if (!point) return;
    setMarquee({ startX: point.x, startY: point.y, x: point.x, y: point.y, width: 0, height: 0 });
    setSelectedId(null);
    setSelectedNodeIds([]);
    setSelectedAnnotationId(null);
  }, [canvasPoint]);

  const continueMarquee = useCallback(() => {
    const point = canvasPoint();
    if (!point) return;
    setMarquee((current) => current
      ? { ...current, ...normalizeSelectionRect(current.startX, current.startY, point.x, point.y) }
      : current);
  }, [canvasPoint]);

  const endMarquee = useCallback(() => {
    if (!marquee) return false;
    const selected = marquee.width * viewport.scale >= 4 && marquee.height * viewport.scale >= 4
      ? selectNodesInRect(nodes, marquee)
      : [];
    setSelectedNodeIds(selected.map((node) => node.id));
    setSelectedId(selected.at(-1)?.id ?? null);
    setSelectedAnnotationId(null);
    setMarquee(null);
    setTool("select");
    if (selected.length > 1) {
      window.requestAnimationFrame(() => inspectorRef.current?.scrollTo({ top: 0, behavior: "smooth" }));
    }
    setNotice(selected.length
      ? `已批量框选 ${selected.length} 张图片；可在画布工作台统一设置阶段并发送。`
      : "框选范围内没有图片。");
    return true;
  }, [marquee, nodes, viewport.scale]);

  const beginAnnotation = useCallback(() => {
    if (tool === "select" || tool === "marquee") return;
    if (!selectedNode) {
      setNotice("请先选择一个图片节点，再添加批注。");
      return;
    }
    const point = canvasPoint();
    if (!point) return;
    const id = `annotation_${crypto.randomUUID()}` as const;
    const color = "#7a1820";
    let next: AnnotationState;
    if (tool === "text") {
      setTextEditor({
        annotationId: null,
        sourceAnnotationId: null,
        x: point.x,
        y: point.y,
        value: ""
      });
      setTool("select");
      setNotice("请在画布上的文本框中直接输入；可保留为标注，或加入修改要求。");
      return;
    } else if (tool === "rectangle") {
      next = { id, type: "rectangle", x: point.x, y: point.y, color, width: 0, height: 0 };
    } else {
      next = { id, type: tool, x: point.x, y: point.y, color, points: [0, 0, 0, 0] };
    }
    setAnnotations((current) => [...current, next]);
    setSelectedAnnotationId(id);
    setDrawingId(id);
  }, [canvasPoint, selectedNode, tool]);

  const cancelTextEditor = useCallback(() => {
    const editingExisting = Boolean(textEditor?.annotationId);
    const editingLinkedComment = Boolean(textEditor?.sourceAnnotationId);
    setTextEditor(null);
    setTool("select");
    setNotice(editingExisting
      ? "已取消文字修改，原内容保持不变。"
      : editingLinkedComment
        ? "已关闭意见输入，图形批注仍保留。"
        : "已取消文字标注。");
  }, [textEditor?.annotationId, textEditor?.sourceAnnotationId]);

  const commitTextEditor = useCallback((sendToTask = false) => {
    if (!textEditor) return;
    const text = textEditor.value.trim();
    if (!text) {
      cancelTextEditor();
      return;
    }
    if (textEditor.sourceAnnotationId) {
      setAnnotations((current) => current.map((annotation) =>
        annotation.id === textEditor.sourceAnnotationId
          ? { ...annotation, comment: text }
          : annotation
      ));
      setSelectedAnnotationId(textEditor.sourceAnnotationId);
      setNotice(sendToTask ? "框选意见已加入修改要求。" : "框选意见已保留在批注中。");
    } else if (textEditor.annotationId) {
      setAnnotations((current) => current.map((annotation) =>
        annotation.id === textEditor.annotationId && annotation.type === "text"
          ? { ...annotation, text }
          : annotation
      ));
      setSelectedAnnotationId(textEditor.annotationId);
      setNotice("文字内容已修改；双击文字可再次编辑。");
    } else {
      const id = `annotation_${crypto.randomUUID()}` as const;
      setAnnotations((current) => [...current, {
        id,
        type: "text",
        x: textEditor.x,
        y: textEditor.y,
        color: "#7a1820",
        text,
        width: 240,
        fontSize: 24
      }]);
      setSelectedAnnotationId(id);
      setNotice("文字已放到指定位置；双击文字可再次编辑。");
    }
    if (sendToTask) {
      const source = textEditor.sourceAnnotationId
        ? annotations.find((annotation) => annotation.id === textEditor.sourceAnnotationId)
        : null;
      const prefix = source ? `【${annotationTypeLabel(source.type)}】` : "【文字标注】";
      setTaskInstruction((current) => [current.trim(), `${prefix}${text}`].filter(Boolean).join("\n"));
    }
    setTextEditor(null);
    setTool("select");
    setRevision((current) => current + 1);
  }, [annotations, cancelTextEditor, textEditor]);

  const editTextAnnotation = useCallback((annotation: AnnotationState) => {
    if (annotation.type !== "text") return;
    setSelectedAnnotationId(annotation.id);
    setTextEditor({
      annotationId: annotation.id,
      sourceAnnotationId: null,
      x: annotation.x,
      y: annotation.y,
      value: annotation.text
    });
    setTool("select");
    setNotice("正在直接修改文字；可保留为标注，或加入修改要求。");
  }, []);

  const continueAnnotation = useCallback(() => {
    if (!drawingId) return;
    const point = canvasPoint();
    if (!point) return;
    setAnnotations((current) => current.map((annotation) => {
      if (annotation.id !== drawingId) return annotation;
      const dx = point.x - annotation.x;
      const dy = point.y - annotation.y;
      if (annotation.type === "rectangle") return { ...annotation, width: dx, height: dy };
      if (annotation.type === "arrow") return { ...annotation, points: [0, 0, dx, dy] };
      if (annotation.type === "freehand") {
        const lastX = annotation.points.at(-2) ?? 0;
        const lastY = annotation.points.at(-1) ?? 0;
        if (Math.hypot(dx - lastX, dy - lastY) < 2) return annotation;
        return { ...annotation, points: [...annotation.points, dx, dy] };
      }
      return annotation;
    }));
  }, [canvasPoint, drawingId]);

  const endAnnotation = useCallback(() => {
    if (!drawingId) return;
    const current = annotations.find((annotation) => annotation.id === drawingId);
    const kept = Boolean(
      current
      && (current.type !== "rectangle" || (Math.abs(current.width) >= 8 && Math.abs(current.height) >= 8))
      && (current.type !== "arrow" || Math.hypot(current.points.at(-2) ?? 0, current.points.at(-1) ?? 0) >= 8)
      && (current.type !== "freehand" || current.points.length >= 6)
    );
    setAnnotations((items) => kept
      ? items.map((annotation) =>
        annotation.id === drawingId && annotation.type === "rectangle"
          ? normalizeRectangle(annotation)
          : annotation
      )
      : items.filter((annotation) => annotation.id !== drawingId)
    );
    if (!kept) {
      setSelectedAnnotationId(null);
    } else if (current) {
      const endPoint = current.type === "rectangle"
        ? {
          x: current.x + current.width,
          y: current.y + current.height
        }
        : current.type === "text"
          ? {
            x: current.x,
            y: current.y
          }
        : {
          x: current.x + (current.points.at(-2) ?? 0),
          y: current.y + (current.points.at(-1) ?? 0)
        };
      setTextEditor({
        annotationId: null,
        sourceAnnotationId: current.id,
        x: endPoint.x,
        y: endPoint.y,
        value: current.comment ?? ""
      });
    }
    setDrawingId(null);
    setTool("select");
    if (kept) setRevision((currentRevision) => currentRevision + 1);
    setNotice(kept
      ? "批注已建立；可直接写修改意见并加入右侧修改要求。"
      : "批注范围过小，未保存。");
  }, [annotations, drawingId]);

  const deleteSelectedAnnotation = useCallback(() => {
    if (!selectedAnnotationId) return;
    setAnnotations((current) => current.filter((annotation) => annotation.id !== selectedAnnotationId));
    setSelectedAnnotationId(null);
    setRevision((current) => current + 1);
    setNotice("批注节点已删除；原图与其他批注未修改。");
  }, [selectedAnnotationId]);

  const deleteSelectedImage = useCallback(() => {
    if (!selectedNode) return;
    if (generationTask && !isTerminalStatus(generationTask.status)) {
      setNotice("当前图片正在参与生成任务，任务完成前不能从画布移除。");
      return;
    }
    const workflowReferenced = viewpoints.some((viewpoint) => (
      viewpoint.sourceVersionId === selectedNode.versionId
      || viewpoint.selectedVersionId === selectedNode.versionId
    )) || handoffs.some((handoff) => (
      handoff.sourceVersionId === selectedNode.versionId
      || handoff.selectedVersionId === selectedNode.versionId
    ));
    if (workflowReferenced) {
      setNotice("当前图片已被视角状态或交接记录引用。请先更换该视角的底图／采用成果，历史交接记录保持不删除。");
      return;
    }
    const batchReferenced = batchRun?.styleReferenceVersionId === selectedNode.versionId
      || batchRun?.items.some((item) => (
        item.sourceVersionId === selectedNode.versionId
        || item.resultVersionIds.includes(selectedNode.versionId)
      ));
    if (batchReferenced) {
      setNotice("当前图片已被批量记录引用。请先结束并清除当前批次，再从画布移除图片。");
      return;
    }
    const removedId = selectedNode.id;
    const removedVersionId = selectedNode.versionId;
    const removedName = selectedNode.name;
    browserImageCache.delete(selectedNode.src);
    setNodes((current) => removeImageNode(current, removedId));
    setSelectedId(null);
    setSelectedNodeIds((current) => current.filter((id) => id !== removedId));
    setStructureBaseId((current) => current === removedId ? null : current);
    setStyleReferenceId((current) => current === removedId ? null : current);
    setTaskParentVersionId((current) => current === removedVersionId ? null : current);
    setRevision((current) => current + 1);
    setNotice(`“${removedName}”已从画布移除；项目原始图片文件仍保留。`);
  }, [batchRun, generationTask, handoffs, selectedNode, viewpoints]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editableTarget = Boolean(
        target?.matches("input, textarea, select, button")
        || target?.isContentEditable
      );
      const key = event.key.toLowerCase();
      if (!editableTarget && (event.ctrlKey || event.metaKey) && !event.altKey) {
        if (key === "z") {
          event.preventDefault();
          applyHistory(event.shiftKey ? 1 : -1);
          return;
        }
        if (key === "y") {
          event.preventDefault();
          applyHistory(1);
          return;
        }
      }
      if (!editableTarget && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        const distance = event.shiftKey ? 10 : 1;
        const dx = event.key === "ArrowLeft" ? -distance : event.key === "ArrowRight" ? distance : 0;
        const dy = event.key === "ArrowUp" ? -distance : event.key === "ArrowDown" ? distance : 0;
        if (selectedAnnotation) {
          event.preventDefault();
          updateAnnotation({
            ...selectedAnnotation,
            x: selectedAnnotation.x + dx,
            y: selectedAnnotation.y + dy
          });
          return;
        }
        if (selectedNode) {
          event.preventDefault();
          updateNode({ ...selectedNode, x: selectedNode.x + dx, y: selectedNode.y + dy });
          return;
        }
      }
      const action = canvasKeyboardAction(event.key, {
        editableTarget,
        hasSelectedAnnotation: Boolean(selectedAnnotationId),
        hasSelectedImage: Boolean(selectedId),
        modifierPressed: event.ctrlKey || event.metaKey || event.altKey
      });
      if (!action) return;
      if (action === "exit-annotation") {
        event.preventDefault();
        if (target?.matches("input, textarea, select")) target.blur();
        if (textEditor) {
          cancelTextEditor();
          return;
        }
        if (drawingId) {
          setAnnotations((current) => current.filter((annotation) => annotation.id !== drawingId));
          setDrawingId(null);
        }
        setMarquee(null);
        setSelectedAnnotationId(null);
        setTool("select");
        setNotice("已退出标注模式；现在可以选择、拖动或切换图片节点。");
        return;
      }
      if (action === "delete-annotation") {
        event.preventDefault();
        deleteSelectedAnnotation();
        return;
      }
      if (action === "delete-image") {
        event.preventDefault();
        deleteSelectedImage();
        return;
      }
      if (action === "tool-text") setTool("text");
      if (action === "tool-arrow") setTool("arrow");
      if (action === "tool-freehand") setTool("freehand");
      if (action === "tool-rectangle") setTool("rectangle");
      if (action === "tool-marquee") setTool("marquee");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    applyHistory,
    cancelTextEditor,
    deleteSelectedAnnotation,
    deleteSelectedImage,
    drawingId,
    selectedAnnotation,
    selectedAnnotationId,
    selectedId,
    selectedNode,
    textEditor,
    updateAnnotation,
    updateNode
  ]);

  const exportAnnotationImage = useCallback(async () => {
    if (!selectedNode || exporting) return;
    setExporting(true);
    setNotice("正在生成并校验独立批注图…");
    try {
      const originalSrc = await readCanvasAssetAsDataUrl(selectedNode.assetId, "original");
      const dataUrl = await renderAnnotationExport({ ...selectedNode, src: originalSrc }, annotations);
      const stem = selectedNode.name.replace(/\.[^.]+$/, "");
      const exported = await saveAnnotationExport(`批注_${stem}.png`, dataUrl);
      setNotice(
        exported.deduplicated
          ? `批注图内容未变化，已复用：${exported.asset.original.relativePath}`
          : `批注图已独立保存：${exported.asset.original.relativePath}`
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "批注图保存失败");
    } finally {
      setExporting(false);
    }
  }, [annotations, exporting, selectedNode]);

  const exportOriginalImage = useCallback(async () => {
    if (!selectedNode || downloadingOriginal) return;
    setDownloadingOriginal(true);
    setNotice(`正在准备原图下载：${selectedNode.name}`);
    try {
      await downloadOriginalAsset(selectedNode.assetId, selectedNode.name);
      setNotice(`原图下载已开始：${selectedNode.name}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "原图下载失败");
    } finally {
      setDownloadingOriginal(false);
    }
  }, [downloadingOriginal, selectedNode]);

  const onWheel = useCallback((event: Konva.KonvaEventObject<WheelEvent>) => {
    event.evt.preventDefault();
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer) return;
    const direction = event.evt.deltaY > 0 ? 1 / 1.12 : 1.12;
    setViewport((current) => zoomAtPoint(current, pointer, current.scale * direction));
  }, []);

  const importFiles = useCallback(async (
    files: readonly File[],
    layout: ImportLayout = "cascade"
  ): Promise<ImageNodeState[]> => {
    if (serviceState !== "connected" || importing || !files.length) return [];
    const supported = naturalSortImportFiles(files).filter((file) =>
      ["image/png", "image/jpeg", "image/webp"].includes(file.type) && file.size > 0 && file.size <= 40 * 1024 * 1024
    );
    if (!supported.length) {
      setNotice("没有可导入的图片。请选择 40 MiB 以内的 PNG、JPEG 或 WebP。");
      return [];
    }
    const resolvedLayout: ImportLayout = layout === "vertical" || containsFolderFiles(supported)
      ? "vertical"
      : "cascade";
    setImporting(true);
    setNotice(resolvedLayout === "vertical"
      ? `正在读取文件夹并按文件名顺序导入 ${supported.length} 张图片…`
      : `正在安全导入 ${supported.length} 张图片…`);
    try {
      const importedNodes: ImageNodeState[] = [];
      let reusedAssets = 0;
      const visibleLeft = Math.max(140, (96 - viewport.x) / viewport.scale);
      const visibleTop = Math.max(120, (72 - viewport.y) / viewport.scale);
      const columnX = nodes.length
        ? Math.max(...nodes.map((node) => node.x + node.width)) + 128
        : visibleLeft;
      const columnY = nodes.length ? Math.min(...nodes.map((node) => node.y)) : visibleTop;
      for (const [index, file] of supported.entries()) {
        const dataUrl = await readFileAsDataUrl(file);
        const imported = await importCanvasAsset(file, dataUrl);
        if (imported.deduplicated) reusedAssets += 1;
        let displaySrc = dataUrl;
        if (imported.asset.display) {
          displaySrc = await readCanvasAssetAsObjectUrl(imported.asset.id, "display");
        } else {
          const derivatives = await createImageDerivatives(dataUrl);
          await saveCanvasAssetDerivatives(
            imported.asset.id,
            derivatives.displayDataUrl,
            derivatives.thumbnailDataUrl
          );
          displaySrc = await readCanvasAssetAsObjectUrl(imported.asset.id, "display");
        }
        const frame = fitImportedImage(imported.asset.original.width, imported.asset.original.height);
        const id = `node_${crypto.randomUUID()}` as const;
        const next: ImageNodeState = {
          id,
          assetId: imported.asset.id,
          originalRelativePath: imported.asset.original.relativePath,
          versionId: `version_${crypto.randomUUID()}`,
          origin: "imported",
          parentVersionId: null,
          taskId: null,
          name: imported.asset.originalName,
          src: displaySrc,
          sourceWidth: imported.asset.original.width,
          sourceHeight: imported.asset.original.height,
          x: resolvedLayout === "vertical" ? columnX : 140 + ((nodes.length + index) % 4) * 72,
          y: resolvedLayout === "vertical" ? columnY : 120 + ((nodes.length + index) % 4) * 56,
          width: frame.width,
          height: frame.height,
          outputRatio: "free"
        };
        importedNodes.push(next);
      }
      const placedNodes = resolvedLayout === "vertical"
        ? arrangeVertically(importedNodes, { x: columnX, y: columnY }, 96)
        : importedNodes;
      setNodes((current) => [...current, ...placedNodes]);
      setSelectedId(placedNodes[0]?.id ?? null);
      setSelectedNodeIds(placedNodes[0] ? [placedNodes[0].id] : []);
      setSelectedAnnotationId(null);
      if (resolvedLayout === "vertical") {
        setBatchSourceVersionIds(placedNodes.map((node) => node.versionId));
      }
      setRevision((current) => current + supported.length);
      const copiedAssets = supported.length - reusedAssets;
      setNotice(
        resolvedLayout === "vertical"
          ? `文件夹导入完成：${supported.length} 张图片已按文件名顺序纵向展开，可直接建立批量队列。`
          : copiedAssets > 0
            ? `${copiedAssets} 张原图已复制，${reusedAssets ? `${reusedAssets} 张复用既有资产；` : ""}画布只修改节点位置和图片框。`
            : `${reusedAssets} 张图片已复用既有原始资产；只新增画布节点，不重复写入文件。`
      );
      if (placedNodes[0]) {
        setViewport(fitRect(size, placedNodes[0], 72));
      }
      return placedNodes;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "图片导入失败，请检查本地文件服务。");
      return [];
    } finally {
      setImporting(false);
    }
  }, [importing, nodes, serviceState, size, viewport]);

  const setOutputRatio = useCallback((ratio: OutputRatio) => {
    if (!selectedNode) return;
    updateNode(applyOutputRatio(selectedNode, ratio));
  }, [selectedNode, updateNode]);

  const tidyFrames = useCallback(() => {
    if (!nodes.length) return;
    const reference = selectedNode ?? nodes[0];
    setNodes((current) => normalizeImageFrames(current, reference?.id));
    setRevision((current) => current + 1);
    setNotice(`已按“${reference?.name ?? "第一张图片"}”的高度整理 ${nodes.length} 张图片；宽度按各自原始比例自适应，图片内容完整保留。`);
  }, [nodes, selectedNode]);

  const arrangeImportedColumn = useCallback(() => {
    const selectedSet = new Set(selectedNodeIds);
    const candidates = selectedNodeIds.length > 1
      ? nodes.filter((node) => selectedSet.has(node.id))
      : nodes.filter((node) => node.origin === "imported" && !node.parentVersionId);
    if (candidates.length < 2) {
      setNotice("至少需要两张导入图片才能纵向平铺。可先用框选指定需要整理的图片。");
      return;
    }
    const start = {
      x: Math.min(...candidates.map((node) => node.x)),
      y: Math.min(...candidates.map((node) => node.y))
    };
    const arranged = new Map(arrangeVertically(candidates, start, 96).map((node) => [node.id, node]));
    setNodes((current) => current.map((node) => arranged.get(node.id) ?? node));
    setRevision((current) => current + 1);
    setNotice(`已将 ${candidates.length} 张图片按原顺序纵向平铺，图片之间保留 96 px 间距。`);
  }, [nodes, selectedNodeIds]);

  const assignReferenceRole = useCallback((role: ReferenceRole, nodeId: string) => {
    if (role === "structure-base") {
      setStructureBaseId(nodeId);
      setStyleReferenceId((current) => current === nodeId ? null : current);
      setNotice("已指定结构基准；它将固定为任务附件 1 和唯一结构依据。");
    } else {
      setStyleReferenceId(nodeId);
      setStructureBaseId((current) => current === nodeId ? null : current);
      setNotice("已指定风格参考；它将固定为任务附件 2，仅提供视觉表达参考。");
    }
    setRevision((current) => current + 1);
  }, []);

  const changeBulkStage = useCallback((stage: WorkflowStage) => {
    setBulkStage(stage);
    setWorkflowAction(defaultWorkflowAction(stage));
  }, []);

  const updateTextCard = useCallback((id: CanvasTextCard["id"], patch: Partial<CanvasTextCard>) => {
    setTextCards((current) => current.map((card) => card.id === id
      ? { ...card, ...patch, updatedAt: new Date().toISOString() }
      : card));
  }, []);

  const commitTextCardChange = useCallback(() => {
    setRevision((current) => current + 1);
  }, []);

  const useTextCardForNextTask = useCallback((card: CanvasTextCard, text: string) => {
    const content = text.trim();
    if (!content) {
      setNotice("文字卡中没有可用于下一步的内容。");
      return;
    }
    const source = card.sourceVersionId
      ? nodes.find((node) => node.versionId === card.sourceVersionId) ?? null
      : null;
    if (source) {
      setStructureBaseId(source.id);
      setSelectedId(source.id);
      setSelectedNodeIds([source.id]);
    }
    setTaskInstruction(content);
    setPromptTitle(card.title);
    setWorkflowAction(card.kind === "prompt" ? "generate" : "prompt");
    setSelectedFixedPromptId("");
    setSelectedPromptId("");
    setWorkbenchPanel("preview");
    setRevision((current) => current + 1);
    setNotice(card.kind === "prompt"
      ? "提示词已进入下一步；已切换为“按提示词生成图片”。"
      : "审查文字已进入下一步；已切换为“生成／优化提示词”。");
  }, [nodes]);

  const copyTextCardContent = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("文字卡内容已复制。");
    } catch {
      setNotice("复制失败，请检查浏览器剪贴板权限。");
    }
  }, []);

  const saveTextCardToLibrary = useCallback(async (card: CanvasTextCard, text: string) => {
    const content = text.trim();
    if (!content) return;
    try {
      const saved = await savePromptLibraryItem(card.title, content);
      setPromptLibrary((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setSelectedPromptId(saved.id);
      setSelectedFixedPromptId("");
      setNotice(`已从文字卡保存到提示词库：${saved.title}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "文字卡保存到提示词库失败");
    }
  }, []);

  const removeTextCard = useCallback((card: CanvasTextCard) => {
    setTextCards((current) => current.filter((item) => item.id !== card.id));
    setSelectedTextCardId((current) => current === card.id ? null : current);
    setRevision((current) => current + 1);
    setNotice(`已从画布移除文字卡“${card.title}”；GPT原始任务记录仍保留。`);
  }, []);

  const applyFixedWorkflowPrompt = useCallback((id: string) => {
    const template = fixedWorkflowPromptById(id);
    if (!template) return;
    setSelectedFixedPromptId(template.id);
    setSelectedPromptId("");
    setTaskInstruction(template.content);
    setPromptTitle(template.title);
    if (template.stage) changeBulkStage(template.stage);
    if (template.action) setWorkflowAction(template.action);
    setWorkbenchPanel(null);
    setRevision((current) => current + 1);
    setNotice(`已套用固定工作流卡：${template.title}。方括号内容可按项目补充。`);
  }, [changeBulkStage]);

  const applyPromptTemplate = useCallback((id: string) => {
    setSelectedPromptId(id);
    setSelectedFixedPromptId("");
    const template = promptLibrary.find((item) => item.id === id);
    if (!template) return;
    setTaskInstruction(template.content);
    setPromptTitle(template.title);
    setWorkbenchPanel(null);
    setRevision((current) => current + 1);
    setNotice(`已套用提示词：${template.title}`);
  }, [promptLibrary]);

  const beginProjectRequirementsEdit = useCallback(() => {
    if (!projectRequirements) return;
    const fallback = [
      projectRequirements.generationContext?.trim(),
      ...projectRequirements.sections.map((section) => (
        `## ${section.heading || section.label}\n\n${section.content}`
      ))
    ].filter(Boolean)[0] ?? "";
    setProjectRequirementsDraft(projectRequirements.content?.trim() || fallback);
    setEditingProjectRequirements(true);
    setNotice("已进入项目背景编辑；保存时会另存新版本，原始 Markdown 保持不变。");
  }, [projectRequirements]);

  const saveProjectRequirementsEdit = useCallback(async () => {
    const content = projectRequirementsDraft.trim();
    if (!content || savingProjectRequirements) return;
    setSavingProjectRequirements(true);
    try {
      const saved = await updateActiveProjectRequirements(content);
      setProjectRequirements(saved);
      setProjectRequirementsDraft(saved.content ?? saved.generationContext);
      setEditingProjectRequirements(false);
      setRevision((current) => current + 1);
      setNotice("项目背景已保存为新版本，原始 Markdown 未覆盖。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "项目背景保存失败");
    } finally {
      setSavingProjectRequirements(false);
    }
  }, [projectRequirementsDraft, savingProjectRequirements]);

  const saveCurrentPrompt = useCallback(async () => {
    const title = promptTitle.trim();
    const content = taskInstruction.trim();
    if (!title || !content || savingPrompt) {
      setNotice("填写提示词名称和修改要求后再保存。");
      return;
    }
    setSavingPrompt(true);
    try {
      const saved = await savePromptLibraryItem(
        title,
        content,
        selectedPromptId || undefined
      );
      setPromptLibrary((current) => [
        saved,
        ...current.filter((item) => item.id !== saved.id)
      ]);
      setSelectedPromptId(saved.id);
      setSelectedFixedPromptId("");
      setNotice(`提示词已保存到仓库：${saved.title}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "提示词保存失败");
    } finally {
      setSavingPrompt(false);
    }
  }, [promptTitle, savingPrompt, selectedPromptId, taskInstruction]);

  const deleteCurrentPrompt = useCallback(async () => {
    if (!selectedPromptId || savingPrompt) return;
    const current = promptLibrary.find((item) => item.id === selectedPromptId);
    setSavingPrompt(true);
    try {
      await deletePromptLibraryItem(selectedPromptId);
      setPromptLibrary((items) => items.filter((item) => item.id !== selectedPromptId));
      setSelectedPromptId("");
      setPromptTitle("");
      setNotice(`已从提示词仓库移除：${current?.title ?? "未命名提示词"}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "提示词删除失败");
    } finally {
      setSavingPrompt(false);
    }
  }, [promptLibrary, savingPrompt, selectedPromptId]);

  const createViewpoint = useCallback(() => {
    if (!selectedNode) {
      setNotice("请先选择一张代表该视角的底图或成果图。");
      return;
    }
    const viewpoint: ViewpointStatusCard = {
      id: `viewpoint_${crypto.randomUUID()}`,
      name: defaultViewpointName(selectedNode.name),
      purpose: "",
      stage: "stage-1",
      status: "not-started",
      statusMode: "auto",
      d5Batch: "",
      sourceVersionId: selectedNode.parentVersionId ?? selectedNode.versionId,
      selectedVersionId: selectedNode.origin === "generated" ? selectedNode.versionId : null,
      conclusion: "",
      nextAction: "",
      updatedAt: new Date().toISOString()
    };
    setViewpoints((current) => [...current, viewpoint]);
    setActiveViewpointId(viewpoint.id);
    setRevision((current) => current + 1);
    setNotice(`已建立视角状态卡：${viewpoint.name}`);
  }, [selectedNode]);

  const updateActiveViewpoint = useCallback((patch: Partial<ViewpointStatusCard>) => {
    if (!activeViewpointId) return;
    setViewpoints((current) => current.map((viewpoint) => viewpoint.id === activeViewpointId
      ? { ...viewpoint, ...patch, updatedAt: new Date().toISOString() }
      : viewpoint
    ));
    setRevision((current) => current + 1);
  }, [activeViewpointId]);

  const applyStageToNodes = useCallback((sources: readonly ImageNodeState[], stage: WorkflowStage, announce = true) => {
    if (!sources.length) return;
    const updatedAt = new Date().toISOString();
    const next = [...viewpoints];
    let firstViewpointId: `viewpoint_${string}` | null = null;
    for (const source of sources) {
      const sourceVersionId = source.parentVersionId ?? source.versionId;
      const index = next.findIndex((viewpoint) => (
        viewpoint.sourceVersionId === sourceVersionId
        || viewpoint.selectedVersionId === source.versionId
      ));
      if (index >= 0) {
        const current = next[index]!;
        next[index] = {
          ...current,
          stage,
          selectedVersionId: source.origin === "generated" ? source.versionId : current.selectedVersionId,
          updatedAt
        };
        firstViewpointId ??= current.id;
      } else {
        const viewpoint: ViewpointStatusCard = {
          id: `viewpoint_${crypto.randomUUID()}`,
          name: defaultViewpointName(source.name),
          purpose: "",
          stage,
          status: "not-started",
          statusMode: "auto",
          d5Batch: "",
          sourceVersionId,
          selectedVersionId: source.origin === "generated" ? source.versionId : null,
          conclusion: "",
          nextAction: "",
          updatedAt
        };
        next.push(viewpoint);
        firstViewpointId ??= viewpoint.id;
      }
    }
    setViewpoints(next);
    if (firstViewpointId) setActiveViewpointId(firstViewpointId);
    setRevision((current) => current + 1);
    if (announce) setNotice(`已将 ${sources.length} 张图片统一设置为${WORKFLOW_STAGE_LABELS[stage]}。`);
  }, [viewpoints]);

  const applyBulkStage = useCallback(() => {
    applyStageToNodes(selectedBatchNodes, bulkStage);
  }, [applyStageToNodes, bulkStage, selectedBatchNodes]);

  const updateSelectedNodeWorkflow = useCallback((patch: Partial<ViewpointStatusCard>, message: string) => {
    if (!selectedNode) return;
    const updatedAt = new Date().toISOString();
    const sourceVersionId = selectedNode.parentVersionId ?? selectedNode.versionId;
    const existing = viewpoints.find((viewpoint) => (
      viewpoint.sourceVersionId === sourceVersionId
      || viewpoint.selectedVersionId === selectedNode.versionId
    ));
    const nextActiveId = existing?.id ?? `viewpoint_${crypto.randomUUID()}`;
    setViewpoints((current) => {
      const index = current.findIndex((viewpoint) => viewpoint.id === nextActiveId);
      if (index >= 0) {
        return current.map((viewpoint, currentIndex) => currentIndex === index
          ? { ...viewpoint, ...patch, updatedAt }
          : viewpoint
        );
      }
      const created: ViewpointStatusCard = {
        id: nextActiveId,
        name: defaultViewpointName(selectedNode.name),
        purpose: "",
        stage: "stage-1",
        status: "not-started",
        statusMode: "auto",
        d5Batch: "",
        sourceVersionId,
        selectedVersionId: selectedNode.origin === "generated" ? selectedNode.versionId : null,
        conclusion: "",
        nextAction: "",
        updatedAt,
        ...patch
      };
      return [...current, created];
    });
    setActiveViewpointId(nextActiveId);
    setRevision((current) => current + 1);
    setNotice(message);
  }, [selectedNode, viewpoints]);

  const sendSelectionToGpt = useCallback(() => {
    if (!selectedBatchNodes.length) return;
    if (!generationTargetReady) {
      setNotice("已选择专属 GPT，但地址尚未配置；请切回普通 GPT 或补充地址。");
      return;
    }
    if (
      generationActive
      || generationResultsPending
      || creatingTask
      || returningResults
      || (batchRun && batchRun.status !== "completed")
    ) {
      setNotice("当前仍有任务或批次未结束，请完成或清除后再发送所选图片。");
      return;
    }
    try {
      applyStageToNodes(selectedBatchNodes, bulkStage, false);
      const prompt = workflowStagePrompt(bulkStage, workflowAction);
      const run = createStageCanvasBatchRun({
        sources: selectedBatchNodes,
        stage: bulkStage,
        action: workflowAction,
        prompt,
        structureBase,
        styleReference,
        targetChatUrl: activeTargetChatUrl
      });
      setBatchSourceVersionIds(selectedBatchNodes.map((node) => node.versionId));
      setBatchRun({ ...run, status: "running", updatedAt: new Date().toISOString() });
      setGenerationMode("reference-edit");
      setRevision((current) => current + 1);
      setNotice(`已建立 ${run.items.length} 个${WORKFLOW_STAGE_LABELS[bulkStage]}任务组；本轮动作：${WORKFLOW_ACTION_LABELS[workflowAction]}。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "阶段任务组合无效");
    }
  }, [
    applyStageToNodes,
    batchRun,
    bulkStage,
    creatingTask,
    generationActive,
    generationResultsPending,
    activeTargetChatUrl,
    generationTargetReady,
    returningResults,
    selectedBatchNodes,
    structureBase,
    styleReference,
    workflowAction
  ]);

  const attachSelectedAsSource = useCallback(() => {
    if (!activeViewpoint || !selectedNode) {
      setNotice("请选择视角卡和对应底图后再关联。");
      return;
    }
    updateActiveViewpoint({ sourceVersionId: selectedNode.versionId });
    setNotice(`${selectedNode.name} 已设为“${activeViewpoint.name}”的结构／底图。`);
  }, [activeViewpoint, selectedNode, updateActiveViewpoint]);

  const adoptSelectedResult = useCallback(() => {
    if (!activeViewpoint || !selectedNode) {
      setNotice("请选择视角卡和准备采用的成果图。");
      return;
    }
    updateActiveViewpoint({ selectedVersionId: selectedNode.versionId });
    setNotice(`${selectedNode.name} 已在画布登记为“${activeViewpoint.name}”的采用候选；正式写入项目请使用“采用归档”。`);
  }, [activeViewpoint, selectedNode, updateActiveViewpoint]);

  const commitDeliveryTarget = useCallback(async () => {
    if (savingDeliveryTarget || !deliveryTargetDraft.trim()) {
      setNotice("请粘贴正式效果图目录下、以 AI 结尾的绝对路径。");
      return;
    }
    setSavingDeliveryTarget(true);
    try {
      const target = await saveDeliveryTarget(deliveryTargetDraft);
      setDeliveryTarget(target);
      setDeliveryTargetDraft(target.aiDirectory);
      setNotice("正式交接目录已保存；AI 与同级成图目录均已核对。原配置已备份。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "正式交接目录保存失败");
    } finally {
      setSavingDeliveryTarget(false);
    }
  }, [deliveryTargetDraft, savingDeliveryTarget]);

  const adoptSelectedToProject = useCallback(async () => {
    if (!selectedNode || selectedNode.origin !== "generated") {
      setNotice("请选择已由 GPT 生成并回收到画布的成果图。");
      return;
    }
    if (!selectedWorkflowViewpoint) {
      setNotice("请先给当前成果建立视角状态卡并设置实际工作流阶段。");
      return;
    }
    if (!(["stage-3", "stage-4", "final"] as WorkflowStage[]).includes(selectedWorkflowViewpoint.stage)) {
      setNotice("当前阶段只产生判断结论，不应归档为正式 AI 图片；请在阶段 3、阶段 4 或最终检查中采用。");
      return;
    }
    if (!deliveryTarget) {
      setNotice("请先设置正式效果图项目的 AI 目录。");
      return;
    }
    if (adoptingToProject) return;
    setAdoptingToProject(true);
    try {
      const adoption = await adoptCanvasAsset({
        assetId: selectedNode.assetId,
        viewpointName: selectedWorkflowViewpoint.name,
        stage: selectedWorkflowViewpoint.stage as "stage-3" | "stage-4" | "final",
        taskId: selectedNode.taskId,
        versionId: selectedNode.versionId
      });
      updateSelectedNodeWorkflow(
        { selectedVersionId: selectedNode.versionId },
        adoption.deduplicated
          ? `该成果已归档：${adoption.filename}`
          : `已采用并归档：${adoption.filename}`
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "正式归档失败");
    } finally {
      setAdoptingToProject(false);
    }
  }, [
    adoptingToProject,
    deliveryTarget,
    selectedNode,
    selectedWorkflowViewpoint,
    updateSelectedNodeWorkflow
  ]);

  const createHandoffRecord = useCallback(() => {
    if (!activeViewpoint) {
      setNotice("请先建立或选择视角状态卡。");
      return;
    }
    if (!activeViewpoint.conclusion.trim() && !activeViewpoint.nextAction.trim()) {
      setNotice("填写本轮结论或下一步后再记录交接。");
      return;
    }
    const record: StandardHandoffRecord = {
      id: `handoff_${crypto.randomUUID()}`,
      viewpointId: activeViewpoint.id,
      viewpointName: activeViewpoint.name,
      stage: activeViewpoint.stage,
      status: activeViewpointInference?.status ?? activeViewpoint.status,
      target: handoffTarget,
      d5Batch: activeViewpoint.d5Batch,
      sourceVersionId: activeViewpoint.sourceVersionId,
      selectedVersionId: activeViewpoint.selectedVersionId,
      taskId: generationTask?.id ?? null,
      conclusion: activeViewpoint.conclusion.trim(),
      nextAction: activeViewpoint.nextAction.trim(),
      createdAt: new Date().toISOString()
    };
    setHandoffs((current) => [...current, record]);
    setRevision((current) => current + 1);
    setNotice(`已记录“${activeViewpoint.name}”交接，历史记录保持只追加。`);
  }, [activeViewpoint, activeViewpointInference?.status, generationTask?.id, handoffTarget]);

  const copyHandoff = useCallback(async (record: StandardHandoffRecord) => {
    const versionPaths = new Map(nodes.map((node) => [node.versionId, node.originalRelativePath]));
    try {
      await navigator.clipboard.writeText(handoffMarkdown(record, versionPaths));
      setNotice(`已复制“${record.viewpointName}”标准交接记录。`);
    } catch {
      setNotice("交接记录复制失败，请检查浏览器剪贴板权限。");
    }
  }, [nodes]);

  const createTask = useCallback(async () => {
    if (!automationReady || !generationTargetReady || !taskPreview.ready || creatingTask || (generationTask && !isTerminalStatus(generationTask.status))) return;
    setCreatingTask(true);
    setNotice("正在校验附件并创建唯一活动任务…");
    try {
      let attachments = taskPreview.attachments.map((attachment) => ({
        role: attachment.role,
        name: attachment.name,
        relativePath: attachment.relativePath
      }));
      if (
        structureBase
        && structureAnnotations.length
        && attachments.some((attachment) => attachment.role === "annotation-map")
      ) {
        setNotice("正在把结构图与批注合成为任务附件，原图保持不变…");
        const originalSrc = await readCanvasAssetAsDataUrl(structureBase.assetId, "original");
        const dataUrl = await renderAnnotationExport(
          { ...structureBase, src: originalSrc },
          structureAnnotations
        );
        const stem = structureBase.name.replace(/\.[^.]+$/, "");
        const exported = await saveAnnotationExport(`任务批注_${stem}.png`, dataUrl);
        attachments = attachments.map((attachment) => attachment.role === "annotation-map"
          ? {
            role: attachment.role,
            name: exported.asset.originalName,
            relativePath: exported.asset.original.relativePath
          }
          : attachment
        );
      }
      const task = await createGenerationTask({
        taskType: taskPreview.taskType,
        responseMode: workflowAction === "generate" ? "image" : "text",
        target: generationTargetForCustomGpt(activeTargetChatUrl),
        prompt: wrapPromptForAction(workflowAction, taskPreview.prompt),
        attachments
      });
      const acceptedProvider = task.target.provider ?? "chatgpt";
      if (acceptedProvider !== generationProvider) {
        await cancelGenerationTask(task.id).catch(() => undefined);
        throw new Error(
          `桥接服务没有接受 ${PROVIDER_LABELS[generationProvider]} 来源；任务已取消，请重启本地服务后重试。`
        );
      }
      setTaskParentVersionId(structureBase?.versionId ?? null);
      setReturnedResultIds([]);
      setGenerationTask(task);
      automationRunTaskRef.current = task.id;
      document.documentElement.setAttribute("data-gpt-canvas-task-id", task.id);
      window.dispatchEvent(new Event("gpt-canvas-run-task"));
      setNotice(`任务 ${task.id} 已创建；${activeTargetChatUrl ? "专属 GPT" : "普通 GPT"}将执行“${WORKFLOW_ACTION_LABELS[workflowAction]}”。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "任务创建失败");
    } finally {
      setCreatingTask(false);
    }
  }, [
    automationReady,
    creatingTask,
    activeTargetChatUrl,
    generationTargetReady,
    generationProvider,
    generationTask,
    normalizedCustomGptUrl,
    structureAnnotations,
    structureBase,
    taskPreview,
    workflowAction
  ]);

  const startBatch = useCallback(() => {
    if (!automationReady || !generationTargetReady || creatingTask || returningResults || generationActive || generationResultsPending) return;
    const uniqueVersionIds = [...new Set(batchSourceVersionIds)];
    const sources = uniqueVersionIds
      .map((versionId) => nodes.find((node) => node.versionId === versionId))
      .filter((node): node is ImageNodeState => Boolean(node))
      .filter((node) => node.versionId !== styleReference?.versionId);
    if (!sources.length) {
      setNotice("请先使用“文件夹”导入一组待处理图片。");
      return;
    }
    if (!taskInstruction.trim()) {
      setNotice("请先填写本批次统一使用的修改要求。");
      return;
    }
    const run = createCanvasBatchRun(
      sources,
      taskInstruction,
      styleReference?.versionId ?? null,
      {
        targetChatUrl: activeTargetChatUrl,
        responseMode: workflowAction === "generate" ? "image" : "text",
        workflowAction
      }
    );
    setGenerationMode("reference-edit");
    setBatchRun({ ...run, status: "running", updatedAt: new Date().toISOString() });
    setRevision((current) => current + 1);
    setNotice(`批量队列已开始：共 ${sources.length} 张；${WORKFLOW_ACTION_LABELS[workflowAction]}，严格逐张处理。`);
  }, [
    automationReady,
    batchSourceVersionIds,
    creatingTask,
    activeTargetChatUrl,
    generationTargetReady,
    generationActive,
    generationResultsPending,
    nodes,
    normalizedCustomGptUrl,
    returningResults,
    styleReference,
    taskInstruction,
    workflowAction
  ]);

  const pauseBatch = useCallback(() => {
    setBatchRun((current) => current ? {
      ...current,
      status: "paused",
      updatedAt: new Date().toISOString()
    } : current);
    setRevision((current) => current + 1);
    setNotice("批量队列已暂停；已提交的当前图片会继续完成，不再自动发送下一张。");
  }, []);

  const resumeBatch = useCallback((retryFailed = false) => {
    setBatchRun((current) => {
      if (!current) return current;
      const items = retryFailed
        ? current.items.map((item): CanvasBatchItem => item.status === "failed"
          ? { ...item, status: "queued", taskId: null, resultVersionIds: [], error: "" }
          : item)
        : current.items;
      return {
        ...current,
        status: "running",
        items,
        updatedAt: new Date().toISOString()
      };
    });
    setRevision((current) => current + 1);
    setNotice(retryFailed ? "失败项目已重新排队。" : "批量队列已继续。");
  }, []);

  const clearBatch = useCallback(() => {
    if (generationActive) return;
    setBatchRun(null);
    setRevision((current) => current + 1);
    setNotice("批量记录已清除；画布中的原图和生成结果全部保留。");
  }, [generationActive]);

  const startBatchItem = useCallback(async (run: CanvasBatchRun, item: CanvasBatchItem) => {
    if (batchStartInFlightRef.current) return;
    batchStartInFlightRef.current = item.id;
    const source = nodes.find((node) => node.versionId === item.sourceVersionId) ?? null;
    if (!source) {
      setBatchRun((current) => current ? {
        ...updateBatchItem(current, item.id, { status: "failed", error: "源图片已不在画布中" }),
        status: "paused"
      } : current);
      setRevision((current) => current + 1);
      setNotice(`批量任务已暂停：找不到 ${item.sourceName}。`);
      batchStartInFlightRef.current = null;
      return;
    }
    const frozenStyleReference = run.styleReferenceVersionId
      ? nodes.find((node) => node.versionId === run.styleReferenceVersionId) ?? null
      : null;
    const sourceAnnotations = annotations.filter((annotation) => annotationIntersectsRect(annotation, {
      x: source.x,
      y: source.y,
      width: source.width,
      height: source.height
    }));
    const preview = buildGenerationTaskPreview(
      run.prompt,
      source,
      frozenStyleReference,
      "",
      "reference-edit",
      sourceAnnotations.length > 0
    );
    const stageOnly = run.promptMode === "stage-only";
    setCreatingTask(true);
    setNotice(`批量 ${currentBatchProgress.completed + currentBatchProgress.failed + 1}/${currentBatchProgress.total}：正在准备 ${source.name}…`);
    try {
      const stageAttachmentNodes = stageOnly
        ? (item.attachmentVersionIds ?? [source.versionId]).map((versionId) => (
          nodes.find((node) => node.versionId === versionId) ?? null
        ))
        : [];
      if (stageOnly && stageAttachmentNodes.some((node) => !node)) {
        throw new Error("阶段任务中的附件已不在画布中，请重新框选");
      }
      let attachments = stageOnly
        ? stageAttachmentNodes.map((node, index) => ({
          role: item.attachmentRoles?.[index] ?? "content-reference",
          name: node!.name,
          relativePath: node!.originalRelativePath
        }))
        : preview.attachments.map((attachment) => ({
          role: attachment.role,
          name: attachment.name,
          relativePath: attachment.relativePath
        }));
      if (!stageOnly && sourceAnnotations.length && attachments.some((attachment) => attachment.role === "annotation-map")) {
        const originalSrc = await readCanvasAssetAsDataUrl(source.assetId, "original");
        const dataUrl = await renderAnnotationExport({ ...source, src: originalSrc }, sourceAnnotations);
        const stem = source.name.replace(/\.[^.]+$/, "");
        const exported = await saveAnnotationExport(`批量任务批注_${stem}.png`, dataUrl);
        attachments = attachments.map((attachment) => attachment.role === "annotation-map"
          ? {
            role: attachment.role,
            name: exported.asset.originalName,
            relativePath: exported.asset.original.relativePath
          }
          : attachment);
      }
      const task = await createGenerationTask({
        taskType: stageOnly ? "edit" : preview.taskType,
        responseMode: run.responseMode ?? "image",
        target: generationTargetForCustomGpt(run.targetChatUrl ?? ""),
        prompt: stageOnly && run.workflowStage
          ? workflowStagePrompt(run.workflowStage, run.workflowAction ?? defaultWorkflowAction(run.workflowStage), {
            projectName,
            viewpointName: source.name,
            projectContext: projectRequirements?.generationContext ?? "",
            rulesetVersion: run.rulesetVersion,
            sourceAspectRatio: `${source.sourceWidth}:${source.sourceHeight}`,
            attachments: attachments.map((attachment, index) => ({
              index: index + 1,
              role: ATTACHMENT_ROLE_LABELS[attachment.role],
              name: attachment.name
            }))
          })
          : wrapPromptForAction(run.workflowAction ?? "generate", preview.prompt),
        attachments
      });
      if ((task.target.provider ?? "chatgpt") !== "chatgpt") {
        await cancelGenerationTask(task.id).catch(() => undefined);
        throw new Error("桥接服务没有接受 GPT 来源；任务已取消，请重启本地服务后重试。");
      }
      setBatchRun((current) => current
        ? updateBatchItem(current, item.id, { status: "running", taskId: task.id, error: "" })
        : current);
      setTaskParentVersionId(source.versionId);
      setReturnedResultIds([]);
      setGenerationTask(task);
      automationRunTaskRef.current = task.id;
      document.documentElement.setAttribute("data-gpt-canvas-task-id", task.id);
      window.dispatchEvent(new Event("gpt-canvas-run-task"));
      setRevision((current) => current + 1);
      setNotice(`${source.name} 已发送给${run.targetChatUrl ? "专属 GPT" : "普通 GPT"}；${run.responseMode === "text" ? "文字卡" : "图片"}返回后继续下一张。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "批量任务创建失败";
      setBatchRun((current) => current ? {
        ...updateBatchItem(current, item.id, { status: "failed", error: message }),
        status: "paused"
      } : current);
      setRevision((current) => current + 1);
      setNotice(`批量任务已暂停：${message}`);
    } finally {
      batchStartInFlightRef.current = null;
      setCreatingTask(false);
    }
  }, [annotations, currentBatchProgress, nodes, projectName, projectRequirements?.generationContext]);

  useEffect(() => {
    if (
      batchRun?.status !== "running"
      || !automationReady
      || generationActive
      || creatingTask
      || returningResults
      || batchRun.items.some((item) => item.status === "running")
    ) return;
    const next = nextQueuedBatchItem(batchRun);
    if (next) void startBatchItem(batchRun, next);
  }, [automationReady, batchRun, creatingTask, generationActive, returningResults, startBatchItem]);

  useEffect(() => {
    if (!projectLoaded || serviceState !== "connected" || !batchRun) return;
    const runningItem = batchRun.items.find((item) => item.status === "running");
    if (!runningItem || generationTask?.id === runningItem.taskId) return;
    setBatchRun((current) => current ? {
      ...updateBatchItem(current, runningItem.id, {
        status: "failed",
        error: "恢复项目时未找到对应的活动任务"
      }),
      status: "paused"
    } : current);
    setRevision((current) => current + 1);
    setNotice(`批量队列已暂停：${runningItem.sourceName} 的活动任务未恢复，可重试失败项。`);
  }, [batchRun, generationTask?.id, projectLoaded, serviceState]);

  useEffect(() => {
    if (!generationTask) return;
    const item = batchRun?.items.find((candidate) => candidate.taskId === generationTask.id) ?? null;
    if (generationTask.status === "needs-user" && item && batchRun?.status === "running") {
      setBatchRun((current) => current ? {
        ...current,
        status: "paused",
        updatedAt: new Date().toISOString()
      } : current);
      setRevision((current) => current + 1);
      setNotice("GPT 登录或网页验证需要处理，批量队列已安全暂停。当前进度已经保留。");
      return;
    }
    const responseMode = responseModeOf(generationTask);
    const textCompleted = (
      generationTask.status === "completed"
      && generationTask.textResult
      && (responseMode === "text" || (responseMode === "image-or-text" && generationTask.results.length === 0))
    );
    if (textCompleted && generationTask.textResult && !textCards.some((card) => card.taskId === generationTask.id)) {
      const sourceVersionId = item?.sourceVersionId ?? taskParentVersionId;
      const source = sourceVersionId
        ? nodes.find((candidate) => candidate.versionId === sourceVersionId) ?? null
        : structureBase;
      const action = batchRun?.workflowAction
        ?? (generationTask.prompt.includes("【最终生成提示词】") ? "prompt" : "analyze");
      const kind = action === "prompt" ? "prompt" : "review";
      const siblingCount = textCards.filter((card) => card.sourceVersionId === sourceVersionId).length;
      const card = createCanvasTextCard({
        kind,
        title: `${source ? defaultViewpointName(source.name) : "当前任务"}｜${kind === "prompt" ? "生成提示词" : "审查结论"}`,
        text: generationTask.textResult.text,
        sourceVersionId: sourceVersionId ?? null,
        taskId: generationTask.id,
        sourceBounds: source,
        siblingCount
      });
      setTextCards((current) => [...current, card]);
      setSelectedTextCardId(card.id);
      setSelectedId(null);
      setSelectedNodeIds([]);
      setSelectedAnnotationId(null);
      const relatedVersionIds = new Set<`version_${string}`>();
      for (const versionId of item?.attachmentVersionIds ?? (sourceVersionId ? [sourceVersionId] : [])) {
        relatedVersionIds.add(versionId);
        const node = nodes.find((candidate) => candidate.versionId === versionId);
        if (node?.parentVersionId) relatedVersionIds.add(node.parentVersionId);
      }
      const conclusion = generationTask.textResult.text.slice(0, 6_000);
      setViewpoints((current) => current.map((viewpoint) => relatedVersionIds.has(viewpoint.sourceVersionId ?? "version_missing")
        ? {
          ...viewpoint,
          conclusion,
          nextAction: kind === "prompt" ? "确认提示词后选择“按提示词生成图片”。" : "按本轮结论调整后继续下一阶段。",
          updatedAt: new Date().toISOString()
        }
        : viewpoint));
      setBatchRun((current) => current && item
        ? updateBatchItem(current, item.id, { status: "completed", error: "" })
        : current);
      setRevision((current) => current + 1);
      setNotice(`${source?.name ?? "当前任务"} 的${kind === "prompt" ? "提示词" : "文字审查"}已作为可编辑文字卡返回画布。`);
      return;
    }
    if (!item || item.status !== "running") return;
    const completedWithoutExpectedResult = generationTask.status === "completed" && (
      (responseMode === "image" && generationTask.results.length === 0)
      || (responseMode === "text" && !generationTask.textResult)
      || (responseMode === "image-or-text" && generationTask.results.length === 0 && !generationTask.textResult)
    );
    if (
      generationTask.status === "failed"
      || generationTask.status === "cancelled"
      || completedWithoutExpectedResult
    ) {
      const message = generationTask.events.at(-1)?.note
        ?? (generationTask.status === "cancelled" ? "任务已取消" : "GPT 未返回可收集的图片");
      setBatchRun((current) => current ? {
        ...updateBatchItem(current, item.id, { status: "failed", error: message }),
        status: "paused"
      } : current);
      setRevision((current) => current + 1);
      setNotice(`批量队列已暂停：${item.sourceName} ${message}`);
    }
  }, [batchRun, generationTask, nodes, structureBase, taskParentVersionId, textCards]);

  const cancelActiveTask = useCallback(async () => {
    if (!generationTask || isTerminalStatus(generationTask.status) || cancellingTask) return;
    const providerLabel = PROVIDER_LABELS[generationTask.target.provider ?? "chatgpt"];
    const alreadySubmitted = ["submitted", "generating", "collecting", "returning"].includes(generationTask.status);
    const confirmed = window.confirm(alreadySubmitted
      ? `这会结束本地任务跟踪并允许切换项目，但无法撤回已经发送给 ${providerLabel} 的内容。确定继续吗？`
      : "确定取消当前任务吗？尚未提交的附件和提示词不会发送。");
    if (!confirmed) return;
    setCancellingTask(true);
    try {
      const cancelled = await cancelGenerationTask(generationTask.id);
      automationRunTaskRef.current = null;
      document.documentElement.removeAttribute("data-gpt-canvas-task-id");
      setGenerationTask(cancelled);
      setRevision((current) => current + 1);
      setNotice(alreadySubmitted
        ? `已结束本地任务跟踪；已经发送到 ${providerLabel} 的生成可能仍会继续。`
        : "任务已取消，现在可以修改输入或切换项目。");
    } catch (error) {
      setNotice(error instanceof Error ? `任务取消失败：${error.message}` : "任务取消失败");
    } finally {
      setCancellingTask(false);
    }
  }, [cancellingTask, generationTask]);

  const returnResultsToCanvas = useCallback(async () => {
    if (!generationTask || !generationTask.results.length || returningResults || returnInFlightRef.current) return;
    const parent = nodes.find((node) => node.versionId === taskParentVersionId) ?? structureBase;
    if (!parent && generationTask.taskType !== "new") {
      setNotice("无法确定生成结果的父节点，请重新指定结构基准。");
      return;
    }
    const pending = generationTask.results.filter((result) => !returnedResultIds.includes(result.id));
    if (!pending.length) {
      setNotice("当前任务结果已经全部回收到画布。");
      return;
    }
    returnInFlightRef.current = true;
    setReturningResults(true);
    setNotice(`正在校验并回收 ${pending.length} 张生成结果…`);
    try {
      const children: ImageNodeState[] = [];
      const activeBatchItem = batchRun?.items.find((item) => item.taskId === generationTask.id) ?? null;
      const isGlassFullFrameTask = (
        batchRun?.workflowStage === "stage-4" && Boolean(activeBatchItem)
      ) || generationTask.prompt.includes("阶段四｜整图玻璃深化");
      for (const [index, result] of pending.entries()) {
        const dataUrl = await readGenerationResultAsDataUrl(generationTask.id, result.id);
        const rawImported = await saveGeneratedAsset(result.filename, dataUrl);
        if (isGlassFullFrameTask && parent && !aspectRatiosMatch(
          parent.sourceWidth,
          parent.sourceHeight,
          rawImported.asset.original.width,
          rawImported.asset.original.height
        )) {
          throw new Error(
            `玻璃整图比例不一致：D5为 ${parent.sourceWidth}:${parent.sourceHeight}，GPT返回 ${rawImported.asset.original.width}:${rawImported.asset.original.height}。已暂停，未裁切结果。`
          );
        }
        const needsExactAlignment = Boolean(
          isGlassFullFrameTask
          && parent
          && (
            rawImported.asset.original.width !== parent.sourceWidth
            || rawImported.asset.original.height !== parent.sourceHeight
          )
        );
        const alignedDataUrl = needsExactAlignment && parent
          ? await resizeImageToExactDimensions(dataUrl, parent.sourceWidth, parent.sourceHeight)
          : dataUrl;
        const imported = needsExactAlignment
          ? await saveGeneratedAsset(alignedGlassFilename(result.filename), alignedDataUrl)
          : rawImported;
        const derivatives = await createImageDerivatives(alignedDataUrl);
        await saveCanvasAssetDerivatives(
          imported.asset.id,
          derivatives.displayDataUrl,
          derivatives.thumbnailDataUrl
        );
        const frame = fitImportedImage(imported.asset.original.width, imported.asset.original.height);
        const nextNode: ImageNodeState = {
          id: `node_${crypto.randomUUID()}`,
          assetId: imported.asset.id,
          originalRelativePath: imported.asset.original.relativePath,
          versionId: `version_${crypto.randomUUID()}`,
          origin: "generated",
          parentVersionId: parent?.versionId ?? null,
          taskId: generationTask.id,
          name: imported.asset.originalName,
          src: await readCanvasAssetAsObjectUrl(imported.asset.id, "display"),
          sourceWidth: imported.asset.original.width,
          sourceHeight: imported.asset.original.height,
          x: 0,
          y: 0,
          width: frame.width,
          height: frame.height,
          outputRatio: "free"
        };
        const child = parent
          ? placeChildToRight(parent, nextNode)
          : {
            ...nextNode,
            x: (size.width / 2 - viewport.x) / viewport.scale,
            y: (size.height / 2 - viewport.y) / viewport.scale - frame.height / 2
          };
        children.push({ ...child, x: child.x + index * (frame.width + 64) });
      }
      setNodes((current) => [...current, ...children]);
      setReturnedResultIds((current) => [...current, ...pending.map((result) => result.id)]);
      setBatchRun((current) => {
        if (!current) return current;
        const item = current.items.find((candidate) => candidate.taskId === generationTask.id);
        if (!item) return current;
        return updateBatchItem(current, item.id, {
          status: "completed",
          resultVersionIds: [...item.resultVersionIds, ...children.map((child) => child.versionId)],
          error: ""
        });
      });
      setSelectedId(children.at(-1)?.id ?? parent?.id ?? null);
      setSelectedAnnotationId(null);
      setRevision((current) => current + children.length);
      const bounds = parent
        ? {
          x: parent.x,
          y: Math.min(parent.y, ...children.map((node) => node.y)),
          width: Math.max(...children.map((node) => node.x + node.width)) - parent.x,
          height: Math.max(parent.height, ...children.map((node) => node.height))
        }
        : {
          x: Math.min(...children.map((node) => node.x)),
          y: Math.min(...children.map((node) => node.y)),
          width: Math.max(...children.map((node) => node.x + node.width))
            - Math.min(...children.map((node) => node.x)),
          height: Math.max(...children.map((node) => node.y + node.height))
            - Math.min(...children.map((node) => node.y))
        };
      setViewport(fitRect(size, bounds, 72));
      setNotice(parent
        ? isGlassFullFrameTask
          ? `${children.length} 张玻璃整图已返回；比例已核对，像素尺寸不同的版本已生成PS对齐副本。`
          : `${children.length} 张结果已放到父节点右侧并自动选中；可用图片上方工具栏下载原图或指定任务角色。`
        : `${children.length} 张文生图结果已回收到画布并自动选中；可用图片上方工具栏继续操作。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "生成结果回收失败";
      setBatchRun((current) => {
        if (!current) return current;
        const item = current.items.find((candidate) => candidate.taskId === generationTask.id);
        return item ? {
          ...updateBatchItem(current, item.id, { error: message }),
          status: "paused"
        } : current;
      });
      setNotice(message);
    } finally {
      returnInFlightRef.current = false;
      setReturningResults(false);
    }
  }, [
    generationTask,
    batchRun,
    nodes,
    returnedResultIds,
    returningResults,
    size,
    structureBase,
    taskParentVersionId
    ,
    viewport
  ]);

  useEffect(() => {
    const resultCount = generationTask?.results.length ?? 0;
    const returnedCount = generationTask
      ? generationTask.results.filter((result) => returnedResultIds.includes(result.id)).length
      : 0;
    if (shouldAutoReturnResults(generationTask?.status, resultCount, returnedCount, returningResults)) {
      void returnResultsToCanvas();
    }
  }, [generationTask, returnedResultIds, returningResults, returnResultsToCanvas]);

  const generationRelations = useMemo(() => {
    const imageRelations = nodes.flatMap((child) => {
    if (!child.parentVersionId) return [];
    const parent = nodes.find((candidate) => candidate.versionId === child.parentVersionId);
    if (!parent) return [];
    const relation = buildCanvasRelation(parent, child);
    return [{
      id: `${parent.id}-${child.id}`,
      points: relation.points
    }];
    });
    const cardRelations = textCards.flatMap((card) => {
      if (!card.sourceVersionId) return [];
      const parent = nodes.find((candidate) => candidate.versionId === card.sourceVersionId);
      if (!parent) return [];
      return [{ id: `${parent.id}-${card.id}`, points: buildCanvasRelation(parent, card).points }];
    });
    return [...imageRelations, ...cardRelations];
  }, [nodes, textCards]);

  const imageWorkflowBadges = useMemo(() => {
    const badges = new Map<string, ImageWorkflowBadge>();
    for (const viewpoint of viewpoints) {
      const inference = viewpointInferences.get(viewpoint.id);
      if (!inference) continue;
      if (viewpoint.sourceVersionId) {
        for (const candidate of nodes.filter((node) => node.parentVersionId === viewpoint.sourceVersionId)) {
          badges.set(candidate.versionId, {
            stage: viewpoint.stage,
            status: inference.status,
            mode: inference.mode,
            relation: "候选"
          });
        }
        badges.set(viewpoint.sourceVersionId, {
          stage: viewpoint.stage,
          status: inference.status,
          mode: inference.mode,
          relation: "底图"
        });
      }
      if (viewpoint.selectedVersionId) {
        badges.set(viewpoint.selectedVersionId, {
          stage: viewpoint.stage,
          status: inference.status,
          mode: inference.mode,
          relation: "采用"
        });
      }
    }
    return badges;
  }, [nodes, viewpointInferences, viewpoints]);

  const visibleImageNodeIds = useMemo(() => {
    const margin = 320 / viewport.scale;
    const left = -viewport.x / viewport.scale - margin;
    const top = -viewport.y / viewport.scale - margin;
    const right = left + size.width / viewport.scale + margin * 2;
    const bottom = top + size.height / viewport.scale + margin * 2;
    return new Set(nodes
      .filter((node) => (
        node.x + node.width >= left
        && node.x <= right
        && node.y + node.height >= top
        && node.y <= bottom
      ))
      .map((node) => node.id));
  }, [nodes, size.height, size.width, viewport]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#canvas-main">跳到画布</a>

      <aside className="tool-rail" aria-label="画布工具">
        <input
          ref={imageInputRef}
          className="visually-hidden"
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
          onChange={(event) => {
            void importFiles(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        <input
          ref={folderInputRef}
          className="visually-hidden"
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(event) => {
            void importFiles(Array.from(event.target.files ?? []), "vertical");
            event.target.value = "";
          }}
        />
        <div className="tool-button-grid tool-command-grid">
          <RailCommandButton glyph="←" label="项目" onClick={() => window.location.reload()} />
          <RailCommandButton
            glyph="+"
            label="导入"
            disabled={serviceState !== "connected" || importing}
            onClick={() => imageInputRef.current?.click()}
          />
          <RailCommandButton
            glyph="⇣"
            label="文件夹"
            disabled={serviceState !== "connected" || importing}
            onClick={() => folderInputRef.current?.click()}
          />
          <RailCommandButton glyph="↕" label="纵排" disabled={nodes.length < 2} onClick={arrangeImportedColumn} />
          <RailCommandButton glyph="□" label="整理" disabled={nodes.length < 2} onClick={tidyFrames} />
          <RailCommandButton glyph="↶" label="撤销" disabled={!canUndo} onClick={() => applyHistory(-1)} />
          <RailCommandButton glyph="↷" label="重做" disabled={!canRedo} onClick={() => applyHistory(1)} />
        </div>
        <div className="tool-rail-divider" aria-hidden="true" />
        <div className="tool-button-grid">
          <ToolButton active={tool === "text"} label="文字" shortcut="T" onClick={() => setTool((current) => current === "text" ? "select" : "text")} />
          <ToolButton active={tool === "marquee"} label="批选" shortcut="M" onClick={() => setTool((current) => current === "marquee" ? "select" : "marquee")} />
          <ToolButton active={tool === "arrow"} label="箭头" shortcut="A" onClick={() => setTool((current) => current === "arrow" ? "select" : "arrow")} />
          <ToolButton active={tool === "freehand"} label="画笔" shortcut="P" onClick={() => setTool((current) => current === "freehand" ? "select" : "freehand")} />
          <ToolButton active={tool === "rectangle"} label="矩形" shortcut="R" onClick={() => setTool((current) => current === "rectangle" ? "select" : "rectangle")} />
        </div>
      </aside>

      <main
        id="canvas-main"
        className="canvas-region"
        data-middle-panning={middlePanning || undefined}
        data-marquee={tool === "marquee" || marquee || undefined}
        ref={canvasRef}
        tabIndex={0}
        aria-label="无限画布"
        aria-describedby="canvas-status"
        onAuxClick={(event) => {
          if (isMiddleMouseButton(event.button)) event.preventDefault();
        }}
        onDragOver={(event) => {
          if (serviceState === "connected") event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          void importFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <Stage
          ref={stageRef}
          width={size.width}
          height={size.height}
          x={viewport.x}
          y={viewport.y}
          scaleX={viewport.scale}
          scaleY={viewport.scale}
          draggable={middlePanning}
          onDragEnd={(event) => {
            if (middlePanningRef.current) {
              setViewport((current) => ({ ...current, x: event.target.x(), y: event.target.y() }));
            }
            endMiddlePan();
          }}
          onWheel={onWheel}
          onMouseDown={(event) => {
            if (beginMiddlePan(event)) return;
            const canvasBackground = event.target === event.target.getStage();
            if (canvasBackground && shouldStartMarqueeOnBackground(tool)) {
              beginMarquee();
              return;
            }
            if (tool === "select") {
              return;
            }
            beginAnnotation();
          }}
          onMouseMove={() => marquee ? continueMarquee() : continueAnnotation()}
          onMouseUp={() => {
            if (endMiddlePan()) return;
            if (endMarquee()) return;
            endAnnotation();
          }}
        >
          <Layer listening={false}>
            {generationRelations.map((relation) => (
              <Arrow
                key={relation.id}
                points={relation.points}
                stroke="#7a1820"
                fill="#7a1820"
                strokeWidth={2 / viewport.scale}
                pointerLength={10 / viewport.scale}
                pointerWidth={8 / viewport.scale}
                bezier
                opacity={0.8}
                lineJoin="round"
                listening={false}
              />
            ))}
          </Layer>
          <Layer>
            {!nodes.length && (
              <Group x={160} y={130} listening={false}>
                <Rect width={720} height={420} fill="#ffffff" stroke="#bdbdbd" dash={[14, 10]} strokeWidth={2} />
                <Line points={[72, 92, 648, 92]} stroke="#dedede" strokeWidth={1} />
                <Text x={72} y={126} text="DROP / IMPORT" fontFamily="Bahnschrift" fontSize={13} fill="#7a1820" letterSpacing={3} />
                <Text x={72} y={172} text="导入第一张建筑图" fontFamily="Microsoft YaHei UI" fontSize={34} fill="#171717" />
                <Text x={72} y={232} width={560} text="支持 PNG、JPEG、WebP，单张不超过 40 MiB。\n原图复制后只读保存，画布操作不会覆盖源文件。" fontFamily="Microsoft YaHei UI" fontSize={17} lineHeight={1.8} fill="#666666" />
              </Group>
            )}
            {nodes.map((node) => (
              <CanvasImageNode
                key={node.id}
                node={node}
                selected={(selectedId === node.id || selectedNodeIds.includes(node.id)) && !selectedAnnotationId}
                selectable={tool === "select"}
                loadImage={selectedId === node.id || visibleImageNodeIds.has(node.id)}
                viewportScale={viewport.scale}
                roleLabel={
                  structureBaseId === node.id
                    ? "01 结构基准"
                    : styleReferenceId === node.id
                      ? "02 风格参考"
                      : undefined
                }
                workflowBadge={imageWorkflowBadges.get(node.versionId)}
                register={(instance) => {
                  if (instance) nodeRefs.current.set(node.id, instance);
                  else nodeRefs.current.delete(node.id);
                }}
                onSelect={() => {
                  setSelectedId(node.id);
                  setSelectedNodeIds([node.id]);
                  setSelectedAnnotationId(null);
                  setSelectedTextCardId(null);
                }}
                onManipulationStart={() => setManipulatingNodeId(node.id)}
                onManipulationEnd={() => setManipulatingNodeId(null)}
                onChange={updateNode}
              />
            ))}
            {annotations.map((annotation) => (
              <CanvasAnnotation
                key={annotation.id}
                annotation={annotation}
                selected={selectedAnnotationId === annotation.id}
                selectable={tool === "select"}
                register={(instance) => {
                  if (instance) annotationRefs.current.set(annotation.id, instance);
                  else annotationRefs.current.delete(annotation.id);
                }}
                onSelect={() => {
                  setSelectedAnnotationId(annotation.id);
                  setSelectedTextCardId(null);
                }}
                onEdit={() => editTextAnnotation(annotation)}
                onChange={updateAnnotation}
              />
            ))}
            {marquee && (
              <Rect
                x={marquee.x}
                y={marquee.y}
                width={marquee.width}
                height={marquee.height}
                fill="rgba(122, 24, 32, 0.08)"
                stroke="#7a1820"
                strokeWidth={1.5 / viewport.scale}
                dash={[10 / viewport.scale, 6 / viewport.scale]}
                listening={false}
              />
            )}
            <Transformer
              ref={transformerRef}
              rotateEnabled={false}
              keepRatio
              enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right"]}
              borderStroke="#7a1820"
              anchorFill="#ffffff"
              anchorStroke="#7a1820"
              anchorSize={12}
              boundBoxFunc={(oldBox, newBox) => newBox.width < 120 || newBox.height < 80 ? oldBox : newBox}
              visible={tool === "select" && Boolean(selectedNode) && !selectedAnnotation}
            />
            <Transformer
              ref={annotationTransformerRef}
              rotateEnabled={false}
              keepRatio={selectedAnnotation?.type !== "rectangle"}
              enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right"]}
              borderStroke="#7a1820"
              anchorFill="#ffffff"
              anchorStroke="#7a1820"
              anchorSize={10}
              boundBoxFunc={(oldBox, newBox) => newBox.width < 24 || newBox.height < 18 ? oldBox : newBox}
              visible={tool === "select" && Boolean(selectedAnnotation)}
            />
          </Layer>
        </Stage>

        <div className="canvas-text-card-layer" aria-label="GPT文字结果">
          {textCards.map((card) => (
            <CanvasTextCardNode
              key={card.id}
              card={card}
              viewport={viewport}
              selected={selectedTextCardId === card.id}
              onSelect={() => {
                setSelectedTextCardId(card.id);
                setSelectedId(null);
                setSelectedNodeIds([]);
                setSelectedAnnotationId(null);
              }}
              onChange={(patch) => updateTextCard(card.id, patch)}
              onCommit={commitTextCardChange}
              onUse={(text) => useTextCardForNextTask(card, text)}
              onCopy={(text) => void copyTextCardContent(text)}
              onSave={(text) => void saveTextCardToLibrary(card, text)}
              onRemove={() => removeTextCard(card)}
            />
          ))}
        </div>

        {selectedNode && imageToolbarPlacement && (
          <div
            className="image-context-toolbar"
            data-placement={imageToolbarPlacement.placement}
            role="toolbar"
            aria-label={`图片工具：${selectedNode.name}`}
            style={{
              left: imageToolbarPlacement.left,
              top: imageToolbarPlacement.top,
              width: imageToolbarPlacement.width
            }}
          >
            <button
              type="button"
              className="context-download"
              disabled={downloadingOriginal}
              title={`下载原图：${selectedNode.name}（${selectedNode.sourceWidth} × ${selectedNode.sourceHeight} px）`}
              onClick={() => void exportOriginalImage()}
            >
              <ImageToolbarIcon kind="download" />
              <span className="context-label">{downloadingOriginal ? "准备中…" : "下载原图"}</span>
            </button>
            <button
              type="button"
              aria-pressed={structureBaseId === selectedNode.id}
              data-active={structureBaseId === selectedNode.id}
              title="设为结构基准与任务附件 1"
              onClick={() => assignReferenceRole("structure-base", selectedNode.id)}
            >
              <ImageToolbarIcon kind="structure" />
              <span className="context-label">结构基准</span>
            </button>
            <button
              type="button"
              aria-pressed={styleReferenceId === selectedNode.id}
              data-active={styleReferenceId === selectedNode.id}
              title="设为风格参考与任务附件 2"
              onClick={() => assignReferenceRole("style-reference", selectedNode.id)}
            >
              <ImageToolbarIcon kind="style" />
              <span className="context-label">风格参考</span>
            </button>
            <label className="context-select" title="图片名称即视角名称；选择阶段后自动建立或更新视角记录">
              <span>工作阶段</span>
              <select
                aria-label={`${selectedNode.name}的工作流阶段`}
                value={selectedWorkflowViewpoint?.stage ?? ""}
                onChange={(event) => updateSelectedNodeWorkflow(
                  { stage: event.target.value as WorkflowStage },
                  `“${defaultViewpointName(selectedNode.name)}”已更新为${WORKFLOW_STAGE_LABELS[event.target.value as WorkflowStage]}。`
                )}
              >
                <option value="" disabled>设置阶段</option>
                {(Object.keys(WORKFLOW_STAGE_CONTROL_LABELS) as WorkflowStage[]).map((stage) => (
                  <option key={stage} value={stage}>{WORKFLOW_STAGE_SHORT_LABELS[stage]}</option>
                ))}
              </select>
            </label>
            <label className="context-select" title={selectedWorkflowInference?.reason ?? "自动判断，也可人工覆盖"}>
              <span>状态</span>
              <select
                aria-label={`${selectedNode.name}的工作流状态`}
                value={selectedWorkflowViewpoint
                  ? selectedWorkflowViewpoint.statusMode === "manual"
                    ? selectedWorkflowViewpoint.status
                    : "auto"
                  : ""}
                onChange={(event) => event.target.value === "auto"
                  ? updateSelectedNodeWorkflow(
                      { statusMode: "auto" },
                      `“${defaultViewpointName(selectedNode.name)}”已恢复自动判断状态。`
                    )
                  : updateSelectedNodeWorkflow(
                      { statusMode: "manual", status: event.target.value as ViewpointStatus },
                      `“${defaultViewpointName(selectedNode.name)}”已人工设置为${VIEWPOINT_STATUS_LABELS[event.target.value as ViewpointStatus]}。`
                    )}
              >
                <option value="" disabled>设置状态</option>
                <option value="auto">自动判断</option>
                {(Object.keys(VIEWPOINT_STATUS_LABELS) as ViewpointStatus[]).map((status) => (
                  <option key={status} value={status}>{VIEWPOINT_STATUS_LABELS[status]}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="context-adopt"
              data-active={selectedWorkflowViewpoint?.selectedVersionId === selectedNode.versionId}
              title="只登记画布采用状态；正式写入请使用采用归档"
              onClick={() => updateSelectedNodeWorkflow(
                { selectedVersionId: selectedNode.versionId },
                `“${selectedNode.name}”已标记为画布采用候选；正式写入项目请使用“采用归档”。`
              )}
            >
              <span className="context-check" aria-hidden="true">✓</span>
              <span className="context-label">标记采用</span>
            </button>
          </div>
        )}

        {textEditor && textEditorPosition && (
          <form
            className="annotation-inline-editor"
            data-linked={Boolean(textEditor.sourceAnnotationId) || undefined}
            style={textEditorPosition}
            onSubmit={(event) => {
              event.preventDefault();
              commitTextEditor(true);
            }}
          >
            <span aria-hidden="true" />
            <textarea
              ref={textEditorRef}
              value={textEditor.value}
              rows={3}
              maxLength={500}
              placeholder={textEditor.sourceAnnotationId ? "输入此处的修改意见…" : "直接输入文字标注…"}
              aria-label="文字标注内容"
              onChange={(event) => setTextEditor((current) =>
                current ? { ...current, value: event.target.value } : current
              )}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  cancelTextEditor();
                } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  commitTextEditor(true);
                }
              }}
            />
            <div>
              <small>Ctrl + Enter 加入修改要求</small>
              <button type="button" onClick={cancelTextEditor}>取消</button>
              <button type="button" onClick={() => commitTextEditor(false)}>保留标注</button>
              <button type="submit">加入修改要求</button>
            </div>
          </form>
        )}

        <div
          id="canvas-status"
          className="canvas-notice"
          role="status"
          aria-live="polite"
          data-tone={serviceState === "offline" ? "error" : "info"}
        >
          <span>{notice}</span>
          {serviceState === "offline" && <button onClick={() => void connectService()}>重新连接</button>}
        </div>
      </main>

      <aside
        ref={inspectorRef}
        className="inspector"
        aria-label="属性与任务"
        data-resizing={resizingWorkbench || undefined}
        style={({
          ...(workbenchHeight ? { "--workbench-height": `${workbenchHeight}px` } : {}),
          ...(workbenchWidth ? { "--workbench-width": `${workbenchWidth}px` } : {})
        } as CSSProperties)}
      >
        <div
          className="workbench-resize-handle"
          role="separator"
          aria-label="拖动调节输入提示词面板高度"
          aria-orientation="horizontal"
          aria-valuemin={224}
          aria-valuemax={720}
          aria-valuenow={workbenchHeight ?? undefined}
          aria-valuetext={workbenchHeight ? `${workbenchHeight} 像素` : "自动高度"}
          tabIndex={0}
          title="悬停展开；上下拖动调节高度；按 Home 恢复自动高度"
          onPointerDown={beginWorkbenchResize}
          onKeyDown={resizeWorkbenchFromKeyboard}
          onDoubleClick={() => {
            setWorkbenchHeight(null);
            try {
              window.localStorage.removeItem(WORKBENCH_HEIGHT_STORAGE_KEY);
            } catch {
              // Keep the automatic height for this session.
            }
          }}
        >
          <span aria-hidden="true" />
          <small>悬停展开 · 拖动调节</small>
        </div>
        {(["left", "right"] as const).map((side) => (
          <div
            key={side}
            className={`workbench-width-handle workbench-width-handle-${side}`}
            role="separator"
            aria-label={`拖动${side === "left" ? "左" : "右"}边框调节输入提示词面板宽度`}
            aria-orientation="vertical"
            aria-valuemin={560}
            aria-valuemax={1376}
            aria-valuenow={workbenchWidth ?? undefined}
            aria-valuetext={workbenchWidth ? `${workbenchWidth} 像素` : "自动宽度"}
            tabIndex={0}
            title="左右拖动调节宽度；按 Home 恢复自动宽度"
            onPointerDown={(event) => beginWorkbenchWidthResize(event, side)}
            onKeyDown={(event) => resizeWorkbenchWidthFromKeyboard(event, side)}
            onDoubleClick={() => {
              setWorkbenchWidth(null);
              try {
                window.localStorage.removeItem(WORKBENCH_WIDTH_STORAGE_KEY);
              } catch {
                // Keep the automatic width for this session.
              }
            }}
          >
            <span aria-hidden="true" />
          </div>
        ))}
        <section className="workflow-section">
          <div className="workflow-heading">
            <div>
              <p className="section-kicker">VIEWPOINT CONTROL</p>
              <h2>人工调节</h2>
            </div>
            <span>{viewpoints.length} 个视角</span>
          </div>

          {selectedBatchNodes.length > 1 && (
            <section className="bulk-selection-panel" aria-label="批量图片阶段设置">
              <div className="bulk-selection-heading">
                <span>
                  <small>BULK SELECTION</small>
                  <strong>已框选 {selectedBatchNodes.length} 张图片</strong>
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedNodeIds([]);
                    setSelectedId(null);
                  }}
                >取消框选</button>
              </div>
              <label>
                <span>统一阶段</span>
                <select value={bulkStage} onChange={(event) => changeBulkStage(event.target.value as WorkflowStage)}>
                  {Object.entries(WORKFLOW_STAGE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>
              <div className="workflow-action-selector" role="radiogroup" aria-label="本轮GPT动作">
                {(Object.keys(WORKFLOW_ACTION_LABELS) as WorkflowAction[]).map((action) => (
                  <button
                    key={action}
                    type="button"
                    role="radio"
                    aria-checked={workflowAction === action}
                    data-active={workflowAction === action}
                    onClick={() => setWorkflowAction(action)}
                  >{WORKFLOW_ACTION_LABELS[action]}</button>
                ))}
              </div>
              <div className="bulk-selection-actions">
                <button type="button" onClick={applyBulkStage}>仅更新阶段</button>
                <button
                  type="button"
                  className="bulk-send"
                  disabled={
                    !generationTargetReady
                    || generationActive
                    || generationResultsPending
                    || creatingTask
                    || returningResults
                    || Boolean(batchRun && batchRun.status !== "completed")
                  }
                  onClick={sendSelectionToGpt}
                >
                  {`发送到${activeTargetChatUrl ? "专属" : "普通"} GPT`}
                </button>
              </div>
              <p>{STAGE_SELECTION_HINTS[bulkStage]}</p>
            </section>
          )}

          <div className="viewpoint-switcher">
            <label htmlFor="active-viewpoint">当前视角</label>
            <div>
              <select
                id="active-viewpoint"
                value={activeViewpointId ?? ""}
                onChange={(event) => {
                  setActiveViewpointId(event.target.value ? event.target.value as `viewpoint_${string}` : null);
                  setRevision((current) => current + 1);
                }}
              >
                <option value="">选择视角状态卡</option>
                {viewpoints.map((viewpoint) => (
                  <option key={viewpoint.id} value={viewpoint.id}>{viewpoint.name}</option>
                ))}
              </select>
              <button type="button" disabled={!selectedNode} onClick={createViewpoint}>新建视角</button>
            </div>
          </div>

          {activeViewpoint && activeViewpointInference ? (
            <div className="viewpoint-card" data-status={activeViewpointInference.status}>
              <div className="status-source-control">
                <div>
                  <span aria-hidden="true" />
                  <strong>{activeViewpointInference.mode === "auto" ? "自动判断" : "人工覆盖"}</strong>
                  <small>{activeViewpointInference.reason}</small>
                </div>
                <div role="radiogroup" aria-label="状态来源">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={activeViewpointInference.mode === "auto"}
                    data-active={activeViewpointInference.mode === "auto"}
                    onClick={() => updateActiveViewpoint({ statusMode: "auto" })}
                  >自动</button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={activeViewpointInference.mode === "manual"}
                    data-active={activeViewpointInference.mode === "manual"}
                    onClick={() => updateActiveViewpoint({
                      statusMode: "manual",
                      status: activeViewpointInference.status
                    })}
                  >人工</button>
                </div>
              </div>

              <div className="viewpoint-fields viewpoint-control-fields">
                <label>
                  <span>当前阶段</span>
                  <select
                    value={activeViewpoint.stage}
                    onChange={(event) => updateActiveViewpoint({ stage: event.target.value as WorkflowStage })}
                  >
                    {Object.entries(WORKFLOW_STAGE_CONTROL_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                {activeViewpointInference.mode === "manual" ? (
                  <label>
                    <span>人工状态</span>
                    <select
                      value={activeViewpoint.status}
                      onChange={(event) => updateActiveViewpoint({ status: event.target.value as ViewpointStatus })}
                    >
                      {Object.entries(VIEWPOINT_STATUS_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>{label}</option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <div className="inferred-status-readout">
                    <span>自动状态</span>
                    <strong>{VIEWPOINT_STATUS_LABELS[activeViewpointInference.status]}</strong>
                  </div>
                )}
              </div>

              <div className="viewpoint-assets">
                <div>
                  <span>结构／底图</span>
                  <strong title={activeViewpoint.sourceVersionId ?? undefined}>
                    {activeViewpointSource?.name ?? (activeViewpoint.sourceVersionId ? "已关联版本" : "未关联")}
                  </strong>
                </div>
                <div>
                  <span>采用成果</span>
                  <strong title={activeViewpoint.selectedVersionId ?? undefined}>
                    {activeViewpointResult?.name ?? (activeViewpoint.selectedVersionId ? "已关联版本" : "待选定")}
                  </strong>
                </div>
                <div className="viewpoint-asset-actions">
                  <button type="button" disabled={!selectedNode} onClick={attachSelectedAsSource}>当前图设为底图</button>
                  <button
                    type="button"
                    disabled={!selectedNode}
                    title="只更新画布采用状态，不写入正式项目目录"
                    onClick={adoptSelectedResult}
                  >标记当前成果</button>
                </div>
              </div>

              <details className="viewpoint-details">
                <summary>
                  <span>视角资料与交接</span>
                  <small>{activeViewpointHandoffs.length} 条记录</small>
                </summary>
                <div className="viewpoint-details-body">
                  <div className="viewpoint-fields viewpoint-fields-primary">
                    <label>
                      <span>视角名称</span>
                      <input
                        value={activeViewpoint.name}
                        maxLength={40}
                        onChange={(event) => updateActiveViewpoint({ name: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>D5批次</span>
                      <input
                        value={activeViewpoint.d5Batch}
                        maxLength={20}
                        placeholder="例如 D5_01"
                        onChange={(event) => updateActiveViewpoint({ d5Batch: event.target.value })}
                      />
                    </label>
                  </div>
                  <label className="viewpoint-purpose">
                    <span>表达目的</span>
                    <input
                      value={activeViewpoint.purpose}
                      maxLength={100}
                      placeholder="例如：主入口人视投标主图"
                      onChange={(event) => updateActiveViewpoint({ purpose: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>本轮结论</span>
                    <textarea
                      rows={3}
                      maxLength={1000}
                      value={activeViewpoint.conclusion}
                      placeholder="只记录已经确认的判断和采用理由。"
                      onChange={(event) => updateActiveViewpoint({ conclusion: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>下一步</span>
                    <textarea
                      rows={2}
                      maxLength={600}
                      value={activeViewpoint.nextAction}
                      placeholder="例如：返回D5降低树木遮挡，再渲染D5_02。"
                      onChange={(event) => updateActiveViewpoint({ nextAction: event.target.value })}
                    />
                  </label>
                  <div className="handoff-compose">
                    <label>
                      <span>交给</span>
                      <select value={handoffTarget} onChange={(event) => setHandoffTarget(event.target.value as HandoffTarget)}>
                        {Object.entries(HANDOFF_TARGET_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </select>
                    </label>
                    <button type="button" onClick={createHandoffRecord}>记录本次交接</button>
                  </div>
                  <div className="handoff-history">
                    <div className="handoff-history-heading">
                      <span>交接记录</span>
                      <small>{activeViewpointHandoffs.length} 条 · 只追加</small>
                    </div>
                    {activeViewpointHandoffs.length ? activeViewpointHandoffs.slice(-3).reverse().map((handoff) => (
                      <article key={handoff.id}>
                        <div>
                          <b>{HANDOFF_TARGET_LABELS[handoff.target]}</b>
                          <time>{new Date(handoff.createdAt).toLocaleString("zh-CN", { hour12: false })}</time>
                        </div>
                        <p>{handoff.conclusion || handoff.nextAction || "已记录交接状态"}</p>
                        <button type="button" onClick={() => void copyHandoff(handoff)}>复制标准记录</button>
                      </article>
                    )) : (
                      <p className="handoff-empty">记录一次交接后，阶段结论和采用版本会固定保存在项目中。</p>
                    )}
                  </div>
                </div>
              </details>
            </div>
          ) : (
            <div className="workflow-empty">
              <strong>先把一张图变成一个视角</strong>
              <p>选择底图或成果图，建立状态卡，再持续登记阶段、采用版本和下一步。</p>
              <button type="button" disabled={!selectedNode} onClick={createViewpoint}>
                {selectedNode ? `从“${selectedNode.name}”建立视角` : "请先选择画布图片"}
              </button>
            </div>
          )}
        </section>

        <div className="generation-workbench">
          <header className="generation-workbench-heading">
            <span className="workbench-input-title">
              <small>INPUT</small>
              <strong>输入提示词</strong>
            </span>
            <nav aria-label="输入提示词附属工具">
              <button
                type="button"
                aria-expanded={workbenchPanel === "batch"}
                data-active={workbenchPanel === "batch"}
                onClick={() => setWorkbenchPanel((current) => current === "batch" ? null : "batch")}
              >
                <b aria-hidden="true">⇢</b>
                <span>发送队列</span>
                <small>{batchRun ? `${currentBatchProgress.completed}/${currentBatchProgress.total}` : batchSourceVersionIds.length}</small>
              </button>
              <button
                type="button"
                aria-expanded={workbenchPanel === "prompts"}
                data-active={workbenchPanel === "prompts"}
                onClick={() => setWorkbenchPanel((current) => current === "prompts" ? null : "prompts")}
              >
                <b aria-hidden="true">T</b>
                <span>项目提示词</span>
                <small>{FIXED_WORKFLOW_PROMPTS.length + promptLibrary.length}</small>
              </button>
              <button
                type="button"
                aria-expanded={workbenchPanel === "preview"}
                data-active={workbenchPanel === "preview"}
                onClick={() => setWorkbenchPanel((current) => current === "preview" ? null : "preview")}
              >
                <b aria-hidden="true">⌕</b>
                <span>任务预览</span>
                <small>{taskPreview.ready ? "就绪" : taskPreview.missing.length}</small>
              </button>
              <button
                type="button"
                aria-expanded={workbenchPanel === "delivery"}
                data-active={workbenchPanel === "delivery"}
                onClick={() => setWorkbenchPanel((current) => current === "delivery" ? null : "delivery")}
              >
                <b aria-hidden="true">✓</b>
                <span>采用归档</span>
                <small>{deliveryTarget ? "已配置" : "待配置"}</small>
              </button>
            </nav>
          </header>
          <div className="generation-drawer-body" data-active-panel={workbenchPanel ?? "none"}>
        <section className="batch-section compact-section" data-status={batchRun?.status ?? "empty"}>
          <div className="task-heading">
            <div>
              <p className="section-kicker">SEND &amp; BATCH</p>
              <h3>{selectedBatchNodes.length > 1 && !batchRun ? "发送与批量处理" : "发送队列"}</h3>
            </div>
            <span>{selectedBatchNodes.length > 1 && !batchRun
              ? `${selectedBatchNodes.length} 张已框选`
              : batchRun
              ? `${currentBatchProgress.completed + currentBatchProgress.failed} / ${currentBatchProgress.total}`
              : `${batchSourceVersionIds.length} 张待建队列`}</span>
          </div>

          <div
            className="dedicated-gpt-target"
            data-state={customGptEnabled && normalizedCustomGptUrl && !editingCustomGptTarget
              ? "ready"
              : customGptDraft.trim() && !normalizeCustomGptUrl(customGptDraft)
                ? "invalid"
                : "default"}
          >
            <span>
              <strong>生成目标</strong>
              <small>{customGptEnabled ? "当前使用可选专属 GPT" : "默认使用普通 GPT 新对话"}</small>
            </span>
            <div className="gpt-target-mode" role="radiogroup" aria-label="GPT目标类型">
              <button
                type="button"
                role="radio"
                aria-checked={!customGptEnabled}
                data-active={!customGptEnabled}
                onClick={() => {
                  setCustomGptEnabled(false);
                  setEditingCustomGptTarget(false);
                  setRevision((current) => current + 1);
                  setNotice("已切换为普通 GPT；每个任务使用独立新对话。");
                }}
              >普通 GPT</button>
              <button
                type="button"
                role="radio"
                aria-checked={customGptEnabled}
                data-active={customGptEnabled}
                onClick={() => {
                  if (normalizedCustomGptUrl) {
                    setCustomGptEnabled(true);
                    setRevision((current) => current + 1);
                  } else {
                    setCustomGptEnabled(true);
                    setEditingCustomGptTarget(true);
                  }
                }}
              >专属 GPT（可选）</button>
            </div>
            {customGptEnabled && normalizedCustomGptUrl && !editingCustomGptTarget ? (
              <div className="dedicated-gpt-locked">
                <span title={normalizedCustomGptUrl}>{normalizedCustomGptUrl}</span>
                <button
                  type="button"
                  disabled={Boolean(batchRun && batchRun.status !== "completed")}
                  onClick={() => {
                    setCustomGptDraft(normalizedCustomGptUrl);
                    setEditingCustomGptTarget(true);
                  }}
                >更换</button>
              </div>
            ) : customGptEnabled ? (
              <div className="dedicated-gpt-editor">
                <input
                  type="url"
                  aria-label="专属 GPT 首页地址"
                  value={customGptDraft}
                  disabled={Boolean(batchRun && batchRun.status !== "completed")}
                  placeholder="粘贴 https://chatgpt.com/g/g-…"
                  onChange={(event) => setCustomGptDraft(event.target.value.slice(0, 500))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitCustomGptTarget();
                    if (event.key === "Escape" && normalizedCustomGptUrl) {
                      setCustomGptDraft(normalizedCustomGptUrl);
                      setEditingCustomGptTarget(false);
                    }
                  }}
                />
                <div>
                  {normalizedCustomGptUrl && (
                    <button
                      type="button"
                      onClick={() => {
                        setCustomGptDraft(normalizedCustomGptUrl);
                        setEditingCustomGptTarget(false);
                      }}
                    >取消</button>
                  )}
                  <button type="button" className="lock-gpt-target" onClick={commitCustomGptTarget}>固定目标</button>
                </div>
              </div>
            ) : <small className="ordinary-gpt-note">无需配置地址；任务会携带完整规则，不依赖聊天历史。</small>}
          </div>

          {batchRun ? (
            <>
              <div className="batch-progress" aria-label={`批量进度 ${currentBatchProgress.percent}%`}>
                <span style={{ width: `${currentBatchProgress.percent}%` }} />
              </div>
              <div className="batch-summary">
                <strong>{batchRun.status === "running"
                  ? "自动处理中"
                  : batchRun.status === "paused"
                    ? "队列已暂停"
                    : batchRun.status === "completed"
                      ? "本批次已完成"
                      : "等待开始"}</strong>
                <small>
                  完成 {currentBatchProgress.completed}
                  {currentBatchProgress.failed ? ` · 失败 ${currentBatchProgress.failed}` : ""}
                  {currentBatchProgress.remaining ? ` · 剩余 ${currentBatchProgress.remaining}` : ""}
                </small>
              </div>
              <ol className="batch-list">
                {batchRun.items.map((item, index) => (
                  <li key={item.id} data-status={item.status} title={item.error || item.sourceName}>
                    <b>{String(index + 1).padStart(2, "0")}</b>
                    <span>
                      <strong>{item.sourceName}</strong>
                      <small>{item.status === "queued"
                        ? "等待发送"
                        : item.status === "running"
                          ? item.error || "GPT 正在处理"
                          : item.status === "completed"
                            ? batchRun.responseMode === "text"
                              ? "文字结论已回写"
                              : batchRun.responseMode === "image-or-text" && item.resultVersionIds.length === 0
                                ? "补充素材说明已回写"
                                : `已回图 ${item.resultVersionIds.length} 张`
                            : item.error || "处理失败"}</small>
                    </span>
                    <i aria-hidden="true" />
                  </li>
                ))}
              </ol>
              <div className="batch-actions">
                {batchRun.status === "running" && (
                  <button type="button" onClick={pauseBatch}>暂停队列</button>
                )}
                {batchRun.status === "paused" && (
                  <button
                    type="button"
                    className="accent-action"
                    disabled={!automationReady}
                    onClick={() => resumeBatch(false)}
                  >继续队列</button>
                )}
                {currentBatchProgress.failed > 0 && batchRun.status !== "running" && (
                  <button
                    type="button"
                    className="accent-action"
                    disabled={!automationReady}
                    onClick={() => resumeBatch(true)}
                  >重试失败项</button>
                )}
                {batchRun.status === "completed" && (
                  <button
                    type="button"
                    className="accent-action"
                    disabled={!taskInstruction.trim() || !automationReady}
                    onClick={startBatch}
                  >重新建立批次</button>
                )}
                <button
                  type="button"
                  disabled={generationActive || generationResultsPending || returningResults}
                  onClick={clearBatch}
                >清除记录</button>
              </div>
            </>
          ) : selectedBatchNodes.length > 0 ? (
            <div className="drawer-selection-batch">
              <p>画布已选中 {selectedBatchNodes.length} 张图片，可按阶段规则组合后发送。</p>
              <label>
                <span>统一阶段</span>
                <select value={bulkStage} onChange={(event) => changeBulkStage(event.target.value as WorkflowStage)}>
                  {(Object.keys(WORKFLOW_STAGE_LABELS) as WorkflowStage[]).map((stage) => (
                    <option key={stage} value={stage}>{WORKFLOW_STAGE_LABELS[stage]}</option>
                  ))}
                </select>
              </label>
              <div className="workflow-action-selector" role="radiogroup" aria-label="本轮GPT动作">
                {(Object.keys(WORKFLOW_ACTION_LABELS) as WorkflowAction[]).map((action) => (
                  <button key={action} type="button" role="radio" aria-checked={workflowAction === action} data-active={workflowAction === action} onClick={() => setWorkflowAction(action)}>
                    {WORKFLOW_ACTION_LABELS[action]}
                  </button>
                ))}
              </div>
              <div>
                <button type="button" onClick={applyBulkStage}>仅更新阶段</button>
                <button
                  type="button"
                  className="task-create"
                  disabled={!generationTargetReady || !automationReady || creatingTask || returningResults}
                  onClick={sendSelectionToGpt}
                >{`组合并发送到${activeTargetChatUrl ? "专属" : "普通"} GPT`}</button>
              </div>
              <small>{STAGE_SELECTION_HINTS[bulkStage]}</small>
            </div>
          ) : (
            <>
              <p className="batch-empty">
                {batchSourceVersionIds.length
                  ? `已准备 ${batchSourceVersionIds.length} 张图片。下方输入内容将作为本批次统一提示词。`
                  : "需要导入新图片时选择文件夹；画布已有图片请直接在空白处按住左键拖框。"}
              </p>
              <button
                type="button"
                className="task-create batch-start"
                disabled={
                  !batchSourceVersionIds.length
                  || !taskInstruction.trim()
                  || !generationTargetReady
                  || !automationReady
                  || creatingTask
                  || returningResults
                  || generationActive
                  || generationResultsPending
                }
                onClick={startBatch}
              >
                {!batchSourceVersionIds.length
                  ? "先在画布拖框选择图片"
                  : !generationTargetReady
                    ? "配置专属 GPT 或切回普通 GPT"
                  : !taskInstruction.trim()
                    ? "填写统一提示词"
                    : `开始批量处理 ${batchSourceVersionIds.length} 张`}
              </button>
            </>
          )}
          <p className="submission-boundary">固定使用 GPT 参考图改图；严格串行，登录失效、网页验证或失败时自动暂停。</p>
        </section>

        <section className="prompt-section compact-section">
          <div className="task-heading">
            <div>
              <p className="section-kicker">PROMPT LIBRARY</p>
              <h3>项目提示词</h3>
            </div>
            <span>{FIXED_WORKFLOW_PROMPTS.length + promptLibrary.length} 条</span>
          </div>

          <div className="prompt-library">
            <select
              className="project-prompt-select"
              aria-label="选择项目提示词"
              value={selectedFixedPromptId
                ? `fixed:${selectedFixedPromptId}`
                : selectedPromptId
                  ? `project:${selectedPromptId}`
                  : ""}
              onChange={(event) => {
                const [kind, id] = event.target.value.split(":", 2);
                if (!id) return;
                if (kind === "fixed") applyFixedWorkflowPrompt(id);
                if (kind === "project") applyPromptTemplate(id);
              }}
            >
              <option value="" disabled>选择项目提示词</option>
              <optgroup label="工作流预设">
                {FIXED_WORKFLOW_PROMPTS.map((prompt) => (
                  <option key={prompt.id} value={`fixed:${prompt.id}`}>{prompt.title}</option>
                ))}
              </optgroup>
              <optgroup label="项目保存">
                {promptLibrary.length ? promptLibrary.map((item) => (
                  <option key={item.id} value={`project:${item.id}`}>{item.title}</option>
                )) : <option disabled>暂无项目保存提示词</option>}
              </optgroup>
            </select>
            <small className="project-prompt-help">
              工作流预设作为下拉选项套用；保存后成为当前项目的自定义提示词。
            </small>
            <input
              aria-label="提示词名称"
              value={promptTitle}
              maxLength={40}
              placeholder="提示词名称"
              onChange={(event) => setPromptTitle(event.target.value)}
            />
            <div className="prompt-library-actions">
              <button
                type="button"
                disabled={!promptTitle.trim() || !taskInstruction.trim() || savingPrompt}
                onClick={() => void saveCurrentPrompt()}
              >
                {savingPrompt ? "保存中…" : selectedPromptId ? "更新" : "保存"}
              </button>
              <button
                type="button"
                disabled={!selectedPromptId || savingPrompt}
                onClick={() => void deleteCurrentPrompt()}
              >
                删除
              </button>
            </div>
          </div>
        </section>

        <section className="task-section compact-section" data-ready={taskPreview.ready}>
          <div className="task-heading">
            <div>
              <p className="section-kicker">TASK PREVIEW</p>
              <h3>任务预览</h3>
            </div>
            <span>{generationActive && generationTask
              ? TASK_STATUS_LABELS[generationTask.status]
              : taskPreview.ready ? "就绪" : "待补"}</span>
          </div>

          <div className="generation-provider generation-provider-static">
            <span>生成来源</span>
            <strong>GPT 主流程</strong>
            <small>Flow 已冻结，不参与当前任务</small>
          </div>

          <div className="workflow-action-selector workflow-action-selector-wide" role="radiogroup" aria-label="GPT任务动作">
            {(Object.keys(WORKFLOW_ACTION_LABELS) as WorkflowAction[]).map((action) => (
              <button
                key={action}
                type="button"
                role="radio"
                aria-checked={workflowAction === action}
                data-active={workflowAction === action}
                onClick={() => setWorkflowAction(action)}
              >
                <b>{WORKFLOW_ACTION_LABELS[action]}</b>
                <span>{action === "analyze" ? "返回审查文字卡" : action === "prompt" ? "返回可编辑提示词卡" : "返回完整图片"}</span>
              </button>
            ))}
          </div>

          <div className="generation-mode" role="radiogroup" aria-label="生成模式">
            <button
              type="button"
              role="radio"
              aria-checked={generationMode === "reference-edit"}
              data-active={generationMode === "reference-edit"}
              onClick={() => setGenerationMode("reference-edit")}
            >
              <b>参考图改图</b>
              <span>锁定结构 · 不带项目背景</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={generationMode === "concept-generation"}
              data-active={generationMode === "concept-generation"}
              onClick={() => setGenerationMode("concept-generation")}
            >
              <b>文生图 / 分析图</b>
              <span>项目背景随任务发送</span>
            </button>
          </div>

          {projectRequirements && (
            <div
              className="project-context-status"
              data-included={taskPreview.includesProjectContext}
            >
              <span>项目背景</span>
              <strong title={projectRequirements.sourceName}>{projectRequirements.title}</strong>
              <small>
                {taskPreview.includesProjectContext
                  ? `${Math.min(4_000, projectRequirements.generationContext.trim().length).toLocaleString("zh-CN")} 字随任务发送`
                  : "当前模式不发送项目背景"}
              </small>
              <button type="button" onClick={beginProjectRequirementsEdit}>编辑</button>
            </div>
          )}

          {structureBase && (
            <p
              className="annotation-attachment-state"
              data-ready={structureAnnotations.length > 0}
            >
              <b>批注附件</b>
              <span>
                {structureAnnotations.length
                  ? `${structureAnnotations.length} 条批注将与参考图合成后发送`
                  : "暂无与参考图相交的批注，发送原图"}
              </span>
            </p>
          )}

          {editingProjectRequirements && projectRequirements && (
            <section className="project-context-editor" aria-label="编辑项目背景">
              <div>
                <strong>编辑项目背景</strong>
                <small>保存后另存新版本，不覆盖 {projectRequirements.sourceName}</small>
              </div>
              <textarea
                value={projectRequirementsDraft}
                rows={12}
                maxLength={350000}
                aria-label="项目背景 Markdown"
                onChange={(event) => setProjectRequirementsDraft(event.target.value)}
              />
              <div>
                <button
                  type="button"
                  disabled={savingProjectRequirements}
                  onClick={() => setEditingProjectRequirements(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={!projectRequirementsDraft.trim() || savingProjectRequirements}
                  onClick={() => void saveProjectRequirementsEdit()}
                >
                  {savingProjectRequirements ? "保存中…" : "保存新版本"}
                </button>
              </div>
            </section>
          )}

          {taskPreview.missing.length > 0 && (
            <p className="task-missing">待补：{taskPreview.missing.map((item) => item === "修改要求" ? "提示词" : item).join("、")}</p>
          )}
          <details className="prompt-preview">
            <summary>
              查看最终提示词
              <small>{taskPreview.prompt.length.toLocaleString("zh-CN")} 字</small>
            </summary>
            <pre>{taskPreview.prompt || "指定结构基准并填写修改要求后生成预览。"}</pre>
          </details>

        </section>

        <section className="delivery-section compact-section" aria-label="采用成果并正式归档">
          <div className="task-heading">
            <div>
              <p className="section-kicker">ADOPT &amp; ARCHIVE</p>
              <h3>采用成果并归档</h3>
            </div>
            <span>{deliveryTarget ? "目录已锁定" : "待设置"}</span>
          </div>
          <div className="delivery-candidate" data-ready={selectedNode?.origin === "generated"}>
            <span>当前候选</span>
            <strong>{selectedNode?.name ?? "请先选择画布成果"}</strong>
            <small>
              {selectedWorkflowViewpoint
                ? `${WORKFLOW_STAGE_LABELS[selectedWorkflowViewpoint.stage]} · ${selectedWorkflowViewpoint.name}`
                : "尚未关联视角状态卡"}
            </small>
          </div>
          <div className="delivery-target">
            <label>
              <span>正式效果图 AI 目录</span>
              <input
                value={deliveryTargetDraft}
                placeholder="D:\\正式项目\\01投标阶段\\效果图\\AI"
                onChange={(event) => setDeliveryTargetDraft(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={savingDeliveryTarget || !deliveryTargetDraft.trim()}
              onClick={() => void commitDeliveryTarget()}
            >
              {savingDeliveryTarget ? "核对中…" : deliveryTarget ? "更新目录" : "设置目录"}
            </button>
            <small>目录必须由项目明确指定并以 AI 结尾；同时核对同级“成图”，不扫描其他项目。</small>
          </div>
          {deliveryTarget && (
            <p className="delivery-path" title={deliveryTarget.aiDirectory}>{deliveryTarget.aiDirectory}</p>
          )}
          <button
            type="button"
            className="adopt-to-project"
            disabled={
              adoptingToProject
              || !deliveryTarget
              || selectedNode?.origin !== "generated"
              || !selectedWorkflowViewpoint
              || !["stage-3", "stage-4", "final"].includes(selectedWorkflowViewpoint.stage)
            }
            onClick={() => void adoptSelectedToProject()}
          >
            {adoptingToProject
              ? "正在安全归档…"
              : selectedWorkflowViewpoint?.stage === "stage-4"
                ? "采用玻璃整图并归档"
                : "采用为正式 AI 版本并归档"}
          </button>
          <p className="submission-boundary">常规成果按“视角名_01”顺延；阶段四整图使用“视角名_玻璃整图_01”，不会混入常规D5版本。</p>
        </section>

          </div>
          <section className="instruction-composer" aria-label="输入提示词">
            <textarea
              id="main-task-instruction"
              value={taskInstruction}
              rows={10}
              maxLength={12000}
              placeholder="输入本轮需要修改的内容。建筑结构、体块关系、轴测视角、道路关系和场地边界等保护规则会自动加入最终提示词。"
              onChange={(event) => {
                setTaskInstruction(event.target.value);
                setRevision((current) => current + 1);
              }}
            />
            <footer className="instruction-composer-footer">
              <span>
                {generationActive && generationTask
                  ? TASK_STATUS_LABELS[generationTask.status]
                  : taskPreview.missing.length
                    ? `待补：${taskPreview.missing.map((item) => item === "修改要求" ? "提示词" : item).join("、")}`
                    : `${taskPreview.prompt.length.toLocaleString("zh-CN")} 字最终提示词`}
              </span>
              <small>{taskInstruction.length.toLocaleString("zh-CN")} / 12,000</small>
              {generationActive && generationTask ? (
                <button
                  type="button"
                  className="composer-cancel"
                  disabled={cancellingTask}
                  onClick={() => void cancelActiveTask()}
                >
                  {cancellingTask ? "正在结束…" : "结束任务"}
                </button>
              ) : (
                <button
                  type="button"
                  className="composer-send"
                  disabled={
                    !taskPreview.ready
                    || !generationTargetReady
                    || !automationReady
                    || creatingTask
                    || generationResultsPending
                    || returningResults
                  }
                  onClick={() => void createTask()}
                >
                  {creatingTask
                    ? "正在创建…"
                    : !automationReady
                      ? `重载扩展 ${MINIMUM_AUTOMATION_EXTENSION_VERSION}`
                      : !generationTargetReady
                        ? "配置专属 GPT 或切回普通 GPT"
                        : taskPreview.ready
                          ? WORKFLOW_ACTION_LABELS[workflowAction]
                          : "补全任务"}
                </button>
              )}
            </footer>
          </section>
        </div>

        <div hidden>
        {selectedAnnotation ? (
          <>
            <section>
              <p className="section-kicker">当前批注</p>
              <h2>{annotationTypeLabel(selectedAnnotation.type)}</h2>
              <dl className="property-grid">
                <div><dt>X</dt><dd>{Math.round(selectedAnnotation.x)}</dd></div>
                <div><dt>Y</dt><dd>{Math.round(selectedAnnotation.y)}</dd></div>
                {selectedAnnotation.type === "rectangle" && (
                  <>
                    <div><dt>W</dt><dd>{Math.round(selectedAnnotation.width)}</dd></div>
                    <div><dt>H</dt><dd>{Math.round(selectedAnnotation.height)}</dd></div>
                  </>
                )}
                {selectedAnnotation.type === "text" && (
                  <>
                    <div><dt>W</dt><dd>{Math.round(selectedAnnotation.width)}</dd></div>
                    <div><dt>字号</dt><dd>{Math.round(selectedAnnotation.fontSize)}</dd></div>
                  </>
                )}
              </dl>
            </section>
            <section className="annotation-editor">
              <div className="section-heading"><span>批注内容</span><small>独立图层</small></div>
              {selectedAnnotation.type === "text" ? (
                <label>
                  <span>文字</span>
                  <textarea
                    value={selectedAnnotation.text}
                    rows={4}
                    onChange={(event) => updateAnnotation({ ...selectedAnnotation, text: event.target.value.slice(0, 500) })}
                  />
                </label>
              ) : (
                <p>拖动批注可调整位置，使用四角控制点可调整范围。批注只存在于独立图层。</p>
              )}
              <button className="danger-action" onClick={deleteSelectedAnnotation}>删除当前批注</button>
            </section>
          </>
        ) : selectedNode ? (
          <>
            <section>
              <p className="section-kicker">当前选中</p>
              <h2 title={selectedNode.name}>{selectedNode.name}</h2>
              <dl className="property-grid">
                <div><dt>X</dt><dd>{Math.round(selectedNode.x)}</dd></div>
                <div><dt>Y</dt><dd>{Math.round(selectedNode.y)}</dd></div>
                <div><dt>W</dt><dd>{Math.round(selectedNode.width)}</dd></div>
                <div><dt>H</dt><dd>{Math.round(selectedNode.height)}</dd></div>
              </dl>
            </section>
            <section className="ratio-section">
              <div className="section-heading"><span>输出比例</span><small>只改图片框</small></div>
              <div className="ratio-options" role="group" aria-label="输出比例">
                {OUTPUT_RATIOS.map((ratio) => (
                  <button
                    key={ratio}
                    aria-pressed={selectedNode.outputRatio === ratio}
                    data-active={selectedNode.outputRatio === ratio}
                    onClick={() => setOutputRatio(ratio)}
                  >
                    {ratio === "free" ? "原始" : ratio}
                  </button>
                ))}
              </div>
              <p className="asset-fact">源图 {selectedNode.sourceWidth} × {selectedNode.sourceHeight} px</p>
            </section>
            <section className="reference-section">
              <div className="section-heading"><span>资产边界</span><small>SHA-256 已登记</small></div>
              <div className="reference-row"><b>原始资产</b><span>{selectedNode.assetId}</span></div>
              <div className="reference-row"><b>画布版本</b><span>{selectedNode.versionId}</span></div>
              {selectedNode.parentVersionId && (
                <div className="reference-row"><b>父级版本</b><span>{selectedNode.parentVersionId}</span></div>
              )}
              {selectedNode.taskId && (
                <div className="reference-row"><b>生成任务</b><span>{selectedNode.taskId}</span></div>
              )}
            </section>
            <section className="role-section">
              <div className="section-heading"><span>任务角色</span><small>附件顺序固定</small></div>
              <div className="role-options" role="group" aria-label="当前图片的任务角色">
                <button
                  aria-pressed={structureBaseId === selectedNode.id}
                  data-active={structureBaseId === selectedNode.id}
                  onClick={() => assignReferenceRole("structure-base", selectedNode.id)}
                >
                  <b>01</b>
                  <span>设为结构基准</span>
                </button>
                <button
                  aria-pressed={styleReferenceId === selectedNode.id}
                  data-active={styleReferenceId === selectedNode.id}
                  onClick={() => assignReferenceRole("style-reference", selectedNode.id)}
                >
                  <b>02</b>
                  <span>设为风格参考</span>
                </button>
              </div>
              <p className="role-note">结构基准是唯一建筑依据；风格参考不得改变建筑与场地关系。</p>
            </section>
          </>
        ) : (
          <section className="inspector-empty">
            <p className="section-kicker">未选择节点</p>
            <h2>{nodes.length ? "选择一张图片" : "等待导入建筑图"}</h2>
            <p>选中图片后可调整位置、大小和输出比例。所有操作只修改节点，不改动原图文件。</p>
          </section>
        )}
        {selectedNode && (
          <section className="export-section">
            <div className="section-heading"><span>交接与导出</span><small>{annotations.length} 条批注</small></div>
            <p>原图保持不变；批注图另存到项目 `annotations` 目录。</p>
            <div className="export-actions">
              <button onClick={() => void exportOriginalImage()}>导出原图</button>
              <button
                className="accent-action"
                disabled={exporting || !annotations.length}
                onClick={() => void exportAnnotationImage()}
              >
                {exporting ? "正在保存…" : "保存批注图"}
              </button>
            </div>
          </section>
        )}
        <section className="task-section" data-ready={taskPreview.ready}>
          <div className="task-heading">
            <div>
              <p className="section-kicker">下一次生成</p>
              <h3>{taskPreview.ready ? "任务预览已就绪" : "补全任务输入"}</h3>
            </div>
            <span>{taskPreview.attachments.length} / 2</span>
          </div>
          <label className="task-instruction">
            <span>修改要求</span>
            <textarea
              value={taskInstruction}
              rows={4}
              maxLength={2000}
              placeholder="例如：提升夜景灯光层次，重点加强主入口暖光和道路照明。"
              onChange={(event) => {
                setTaskInstruction(event.target.value);
                setRevision((current) => current + 1);
              }}
            />
          </label>
          <div className="attachment-order" aria-label="附件顺序">
            {[1, 2].map((order) => {
              const attachment = taskPreview.attachments.find((item) => item.order === order);
              return (
                <div key={order} data-filled={Boolean(attachment)}>
                  <b>{String(order).padStart(2, "0")}</b>
                  <span>
                    <strong>{attachment?.roleLabel ?? (order === 1 ? "结构基准" : "风格参考（可选）")}</strong>
                    <small>{attachment?.name ?? (order === 1 ? "尚未指定" : "可不添加")}</small>
                  </span>
                </div>
              );
            })}
          </div>
          {taskPreview.missing.length > 0 && (
            <p className="task-missing">待补：{taskPreview.missing.join("、")}</p>
          )}
          <details className="prompt-preview" open={taskPreview.ready}>
            <summary>最终提示词预览</summary>
            <pre>{taskPreview.prompt || "填写修改要求后生成预览。"}</pre>
          </details>
          {generationTask && (
            <div className="bridge-task" data-terminal={isTerminalStatus(generationTask.status)}>
              <span>桥接任务</span>
              <b>{generationTask.id}</b>
              <strong>{TASK_STATUS_LABELS[generationTask.status]}</strong>
              <small>
                {generationTask.status === "ready-to-submit"
                  ? "附件和提示词已就绪，扩展正在执行单次自动提交。"
                  : "状态由本地桥接服务读取；完成后结果将自动回到父节点右侧。"}
              </small>
            </div>
          )}
          {generationTask?.status === "completed" && generationTask.results.length > 0 && (
            <button
              className="return-results"
              disabled={returningResults || generationTask.results.every((result) => returnedResultIds.includes(result.id))}
              onClick={() => void returnResultsToCanvas()}
            >
              {returningResults
                ? "正在回收到画布…"
                : generationTask.results.every((result) => returnedResultIds.includes(result.id))
                  ? "结果已回到画布"
                  : `回收 ${generationTask.results.length} 张结果`}
            </button>
          )}
          <button
            className="task-create"
            disabled={
              !taskPreview.ready
              || !generationTargetReady
              || !automationReady
              || creatingTask
              || Boolean(generationTask && !isTerminalStatus(generationTask.status))
            }
            onClick={() => void createTask()}
          >
            {creatingTask
              ? "正在创建…"
              : !automationReady
                ? `请重载扩展 ${MINIMUM_AUTOMATION_EXTENSION_VERSION}`
              : !generationTargetReady
                  ? "配置专属 GPT 或切回普通 GPT"
              : generationTask && !isTerminalStatus(generationTask.status)
                  ? TASK_STATUS_LABELS[generationTask.status]
                  : taskPreview.ready
                  ? `发送到${activeTargetChatUrl ? "专属" : "普通"} GPT · ${WORKFLOW_ACTION_LABELS[workflowAction]}`
                  : "任务输入未完整"}
          </button>
          <p className="submission-boundary">点击一次后自动打开所选生成来源、上传、提交、收集并回图；登录或网页验证异常时才暂停人工处理。</p>
        </section>
        <footer>
          <span>LOCAL ONLY</span>
          <span>SCHEMA 1.0</span>
        </footer>
        </div>
      </aside>
    </div>
  );
}

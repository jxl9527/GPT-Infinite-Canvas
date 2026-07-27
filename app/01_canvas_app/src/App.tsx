import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  connectCanvasSession,
  createGenerationTask,
  downloadOriginalAsset,
  importCanvasAsset,
  listCanvasAssets,
  listPromptLibrary,
  readActiveProjectRequirements,
  readActiveGenerationTask,
  readCanvasAssetAsDataUrl,
  readCanvasProject,
  readFileAsDataUrl,
  readGenerationResultAsDataUrl,
  readGenerationTask,
  saveGeneratedAsset,
  savePromptLibraryItem,
  saveCanvasAssetDerivatives,
  saveCanvasProject,
  saveAnnotationExport,
  deletePromptLibraryItem,
  updateActiveProjectRequirements,
  type ActiveProjectRequirements,
  type PromptLibraryItem
} from "./bridge-client";
import {
  isTerminalStatus,
  type GenerationStatus,
  type GenerationTask
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
  buildCanvasRelation,
  coverCropForRenderedImage,
  fitImportedImage,
  normalizeImageFrames,
  placeChildToRight,
  removeImageNode,
  type ImageNodeState,
  type OutputRatio
} from "./canvas-layout";
import { fitRect, fixedScreenScale, zoomAtPoint, type Viewport } from "./canvas-math";
import { canvasKeyboardAction, isMiddleMouseButton } from "./canvas-input";
import { shouldAutoReturnResults } from "./canvas-automation";
import {
  buildGenerationTaskPreview,
  type GenerationMode,
  type ReferenceRole
} from "./task-preview";
import { createImageDerivatives } from "./image-derivatives";
import {
  buildCanvasProjectDocument,
  restoreCanvasProjectStructure
} from "./project-state";

type Tool = "select" | "text" | "arrow" | "freehand" | "rectangle";
type ServiceState = "connecting" | "connected" | "offline";
type SaveState = "loading" | "saving" | "saved" | "error";

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
  pending.catch(() => browserImageCache.delete(src));
  return pending;
}

function useBrowserImage(src: string) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    void loadBrowserImage(src).then((next) => {
      if (!cancelled) setImage(next);
    }).catch(() => {
      if (!cancelled) setImage(null);
    });
    return () => { cancelled = true; };
  }, [src]);
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

function CanvasImageNode({
  node,
  selected,
  selectable,
  roleLabel,
  viewportScale,
  register,
  onSelect,
  onChange
}: {
  node: ImageNodeState;
  selected: boolean;
  selectable: boolean;
  roleLabel?: string;
  viewportScale: number;
  register: (instance: Konva.Group | null) => void;
  onSelect: () => void;
  onChange: (next: ImageNodeState) => void;
}) {
  const image = useBrowserImage(node.src);
  const roleScale = fixedScreenScale(viewportScale);
  const crop = coverCropForRenderedImage(
    image ? { width: image.naturalWidth, height: image.naturalHeight } : null,
    { width: node.sourceWidth, height: node.sourceHeight },
    { width: node.width, height: node.height }
  );

  return (
    <Group
      x={node.x}
      y={node.y}
      draggable={selectable}
      onClick={selectable ? onSelect : undefined}
      onTap={selectable ? onSelect : undefined}
      onDragEnd={(event) => onChange({ ...node, x: Math.round(event.target.x()), y: Math.round(event.target.y()) })}
    >
      <Group
        ref={register}
        width={node.width}
        height={node.height}
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
        }}
      >
        <Rect
          width={node.width}
          height={node.height}
          fill="#ffffff"
          stroke={selected ? "#7a1820" : "#c8c8c8"}
          strokeWidth={selected ? 2 : 1}
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

const TASK_STATUS_LABELS: Record<GenerationStatus, string> = {
  draft: "草稿",
  queued: "等待扩展领取",
  "opening-chat": "正在打开 ChatGPT",
  uploading: "正在上传附件",
  "ready-to-submit": "正在自动提交",
  submitted: "已自动提交",
  generating: "ChatGPT 正在生成",
  collecting: "正在收集结果",
  returning: "正在回传画布",
  completed: "任务已完成",
  "needs-user": "需要人工处理",
  failed: "任务失败",
  cancelled: "任务已取消"
};

export function App({ projectName }: { projectName: string }) {
  const { ref: canvasRef, size } = useElementSize<HTMLDivElement>();
  const [tool, setTool] = useState<Tool>("select");
  const [nodes, setNodes] = useState<ImageNodeState[]>([]);
  const [annotations, setAnnotations] = useState<AnnotationState[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [drawingId, setDrawingId] = useState<string | null>(null);
  const [textEditor, setTextEditor] = useState<TextEditorState | null>(null);
  const [middlePanning, setMiddlePanning] = useState(false);
  const [viewport, setViewport] = useState<Viewport>({ x: 72, y: 54, scale: 0.74 });
  const [serviceState, setServiceState] = useState<ServiceState>("connecting");
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState("将 PNG、JPEG 或 WebP 拖入画布，原图会复制到项目资产目录。");
  const [revision, setRevision] = useState(1);
  const [structureBaseId, setStructureBaseId] = useState<string | null>(null);
  const [styleReferenceId, setStyleReferenceId] = useState<string | null>(null);
  const [taskInstruction, setTaskInstruction] = useState("");
  const [generationMode, setGenerationMode] = useState<GenerationMode>("reference-edit");
  const [promptLibrary, setPromptLibrary] = useState<PromptLibraryItem[]>([]);
  const [projectRequirements, setProjectRequirements] = useState<ActiveProjectRequirements | null>(null);
  const [editingProjectRequirements, setEditingProjectRequirements] = useState(false);
  const [projectRequirementsDraft, setProjectRequirementsDraft] = useState("");
  const [savingProjectRequirements, setSavingProjectRequirements] = useState(false);
  const [selectedPromptId, setSelectedPromptId] = useState("");
  const [promptTitle, setPromptTitle] = useState("");
  const [savingPrompt, setSavingPrompt] = useState(false);
  const [generationTask, setGenerationTask] = useState<GenerationTask | null>(null);
  const [creatingTask, setCreatingTask] = useState(false);
  const [returningResults, setReturningResults] = useState(false);
  const [automationReady, setAutomationReady] = useState(
    () => ["ready", "started"].includes(document.documentElement.getAttribute("data-gpt-canvas-automation-status") ?? "")
  );
  const [taskParentVersionId, setTaskParentVersionId] = useState<`version_${string}` | null>(null);
  const [returnedResultIds, setReturnedResultIds] = useState<string[]>([]);
  const [projectLoaded, setProjectLoaded] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const stageRef = useRef<Konva.Stage>(null);
  const middlePanningRef = useRef(false);
  const transformerRef = useRef<Konva.Transformer>(null);
  const annotationTransformerRef = useRef<Konva.Transformer>(null);
  const textEditorRef = useRef<HTMLTextAreaElement>(null);
  const promptPickerRef = useRef<HTMLDetailsElement>(null);
  const nodeRefs = useRef(new Map<string, Konva.Group>());
  const annotationRefs = useRef(new Map<string, Konva.Group>());
  const returnInFlightRef = useRef(false);
  const automationRunTaskRef = useRef<string | null>(null);
  const projectIdRef = useRef<`project_${string}`>(`project_${crypto.randomUUID()}`);
  const projectCreatedAtRef = useRef(new Date().toISOString());
  const lastSavedRevisionRef = useRef(-1);
  const snapshottedTaskRef = useRef<string | null>(null);

  useEffect(() => {
    const closePromptPicker = (event: PointerEvent) => {
      const picker = promptPickerRef.current;
      if (picker?.open && event.target instanceof Node && !picker.contains(event.target)) {
        picker.open = false;
      }
    };
    document.addEventListener("pointerdown", closePromptPicker);
    return () => document.removeEventListener("pointerdown", closePromptPicker);
  }, []);

  const selectedNode = nodes.find((node) => node.id === selectedId) ?? null;
  const selectedAnnotation = annotations.find((annotation) => annotation.id === selectedAnnotationId) ?? null;
  const structureBase = nodes.find((node) => node.id === structureBaseId) ?? null;
  const styleReference = nodes.find((node) => node.id === styleReferenceId) ?? null;
  const structureAnnotations = useMemo(() => structureBase
    ? annotations.filter((annotation) => annotationIntersectsRect(annotation, {
      x: structureBase.x,
      y: structureBase.y,
      width: structureBase.width,
      height: structureBase.height
    }))
    : [], [annotations, structureBase]);
  const generationActive = Boolean(generationTask && !isTerminalStatus(generationTask.status));
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
      readActiveProjectRequirements().then(setProjectRequirements)
    ]).catch((error: unknown) => (
      setNotice(error instanceof Error ? error.message : "项目上下文读取失败")
    ));
  }, [serviceState]);

  useEffect(() => {
    const onAutomationStatus = () => {
      const status = document.documentElement.getAttribute("data-gpt-canvas-automation-status");
      const message = document.documentElement.getAttribute("data-gpt-canvas-automation-message");
      if (status === "ready" || status === "started") setAutomationReady(true);
      if (status === "error") automationRunTaskRef.current = null;
      if (message) setNotice(message);
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
              source = readCanvasAssetAsDataUrl(node.assetId, asset?.display ? "display" : "original");
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
          setViewport(restored.viewport);
          setTaskParentVersionId(restored.taskParentVersionId);
          setRevision(project.revision);
          setSelectedId(restoredNodes[0]?.id ?? null);
          setNotice(`项目已恢复：${restoredNodes.length} 个图片节点、${restored.annotations.length} 条批注。`);
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

  useEffect(() => {
    if (serviceState !== "connected" || !projectLoaded) return;
    const timer = window.setTimeout(() => {
      void (async () => {
        setSaveState("saving");
        try {
          const assets = await listCanvasAssets();
          const forceSnapshot = Boolean(
            generationTask?.status === "completed"
            && generationTask.id !== snapshottedTaskRef.current
          );
          const project = buildCanvasProjectDocument({
            projectId: projectIdRef.current,
            title: projectName,
            createdAt: projectCreatedAtRef.current,
            revision,
            viewport,
            nodes,
            annotations,
            assets,
            generationTask,
            taskParentVersionId
          });
          await saveCanvasProject(project, forceSnapshot);
          lastSavedRevisionRef.current = revision;
          if (forceSnapshot && generationTask) snapshottedTaskRef.current = generationTask.id;
          setSaveState("saved");
        } catch (error) {
          setSaveState("error");
          setNotice(error instanceof Error ? `自动保存失败：${error.message}` : "自动保存失败");
        }
      })();
    }, 500);
    return () => window.clearTimeout(timer);
  }, [
    annotations,
    generationTask?.id,
    generationTask?.status,
    nodes,
    projectName,
    projectLoaded,
    revision,
    serviceState,
    taskParentVersionId,
    viewport
  ]);

  useEffect(() => {
    if (!generationTask || isTerminalStatus(generationTask.status)) return;
    const timer = window.setInterval(() => {
      void readGenerationTask(generationTask.id)
        .then(setGenerationTask)
        .catch(() => undefined);
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [generationTask?.id, generationTask?.status]);

  useEffect(() => {
    const transformer = transformerRef.current;
    const selected = selectedId && !selectedAnnotationId ? nodeRefs.current.get(selectedId) : undefined;
    transformer?.nodes(selected ? [selected] : []);
    transformer?.getLayer()?.batchDraw();
  }, [nodes, selectedAnnotationId, selectedId, tool]);

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

  const beginAnnotation = useCallback(() => {
    if (tool === "select") return;
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
    setRevision((current) => current + 1);
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
    const removedId = selectedNode.id;
    const removedVersionId = selectedNode.versionId;
    const removedName = selectedNode.name;
    setNodes((current) => removeImageNode(current, removedId));
    setSelectedId(null);
    setStructureBaseId((current) => current === removedId ? null : current);
    setStyleReferenceId((current) => current === removedId ? null : current);
    setTaskParentVersionId((current) => current === removedVersionId ? null : current);
    setRevision((current) => current + 1);
    setNotice(`“${removedName}”已从画布移除；项目原始图片文件仍保留。`);
  }, [generationTask, selectedNode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const action = canvasKeyboardAction(event.key, {
        editableTarget: Boolean(
          target?.matches("input, textarea, select, button")
          || target?.isContentEditable
        ),
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
          setRevision((current) => current + 1);
        }
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
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancelTextEditor, deleteSelectedAnnotation, deleteSelectedImage, drawingId, selectedAnnotationId, selectedId, textEditor]);

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
    if (!selectedNode) return;
    try {
      await downloadOriginalAsset(selectedNode.assetId, selectedNode.name);
      setNotice("原图下载已开始；项目内原始资产未修改。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "原图导出失败");
    }
  }, [selectedNode]);

  const onWheel = useCallback((event: Konva.KonvaEventObject<WheelEvent>) => {
    event.evt.preventDefault();
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer) return;
    const direction = event.evt.deltaY > 0 ? 1 / 1.12 : 1.12;
    setViewport((current) => zoomAtPoint(current, pointer, current.scale * direction));
  }, []);

  const importFiles = useCallback(async (files: readonly File[]) => {
    if (serviceState !== "connected" || importing || !files.length) return;
    const supported = files.filter((file) =>
      ["image/png", "image/jpeg", "image/webp"].includes(file.type) && file.size > 0 && file.size <= 40 * 1024 * 1024
    );
    if (!supported.length) {
      setNotice("没有可导入的图片。请选择 40 MiB 以内的 PNG、JPEG 或 WebP。");
      return;
    }
    setImporting(true);
    setNotice(`正在安全导入 ${supported.length} 张图片…`);
    try {
      let lastNode: ImageNodeState | null = null;
      let reusedAssets = 0;
      for (const [index, file] of supported.entries()) {
        const dataUrl = await readFileAsDataUrl(file);
        const imported = await importCanvasAsset(file, dataUrl);
        if (imported.deduplicated) reusedAssets += 1;
        let displaySrc = dataUrl;
        if (imported.asset.display) {
          displaySrc = await readCanvasAssetAsDataUrl(imported.asset.id, "display");
        } else {
          const derivatives = await createImageDerivatives(dataUrl);
          await saveCanvasAssetDerivatives(
            imported.asset.id,
            derivatives.displayDataUrl,
            derivatives.thumbnailDataUrl
          );
          displaySrc = derivatives.displayDataUrl;
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
          x: 140 + ((nodes.length + index) % 4) * 72,
          y: 120 + ((nodes.length + index) % 4) * 56,
          width: frame.width,
          height: frame.height,
          outputRatio: "free"
        };
        setNodes((current) => [...current, next]);
        setSelectedId(next.id);
        lastNode = next;
      }
      setRevision((current) => current + supported.length);
      const copiedAssets = supported.length - reusedAssets;
      setNotice(
        copiedAssets > 0
          ? `${copiedAssets} 张原图已复制，${reusedAssets ? `${reusedAssets} 张复用既有资产；` : ""}画布只修改节点位置和图片框。`
          : `${reusedAssets} 张图片已复用既有原始资产；只新增画布节点，不重复写入文件。`
      );
      if (lastNode) {
        setViewport(fitRect(size, lastNode, 72));
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "图片导入失败，请检查本地文件服务。");
    } finally {
      setImporting(false);
    }
  }, [importing, nodes.length, serviceState, size]);

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

  const applyPromptTemplate = useCallback((id: string) => {
    setSelectedPromptId(id);
    if (promptPickerRef.current) promptPickerRef.current.open = false;
    const template = promptLibrary.find((item) => item.id === id);
    if (!template) return;
    setTaskInstruction(template.content);
    setPromptTitle(template.title);
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

  const createTask = useCallback(async () => {
    if (!automationReady || !taskPreview.ready || creatingTask || (generationTask && !isTerminalStatus(generationTask.status))) return;
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
        target: { chatMode: "new" },
        prompt: taskPreview.prompt,
        attachments
      });
      setTaskParentVersionId(structureBase?.versionId ?? null);
      setReturnedResultIds([]);
      setGenerationTask(task);
      automationRunTaskRef.current = task.id;
      document.documentElement.setAttribute("data-gpt-canvas-task-id", task.id);
      window.dispatchEvent(new Event("gpt-canvas-run-task"));
      setNotice(`任务 ${task.id} 已创建；ChatGPT 将在后台自动上传、提交并回图。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "任务创建失败");
    } finally {
      setCreatingTask(false);
    }
  }, [
    automationReady,
    creatingTask,
    generationTask,
    structureAnnotations,
    structureBase,
    taskPreview
  ]);

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
      for (const [index, result] of pending.entries()) {
        const dataUrl = await readGenerationResultAsDataUrl(generationTask.id, result.id);
        const imported = await saveGeneratedAsset(result.filename, dataUrl);
        const derivatives = await createImageDerivatives(dataUrl);
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
          name: result.filename,
          src: derivatives.displayDataUrl,
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
        ? `${children.length} 张结果已放到父节点右侧，并写入可恢复的父子版本关系。`
        : `${children.length} 张文生图结果已回收到当前画布。`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "生成结果回收失败");
    } finally {
      returnInFlightRef.current = false;
      setReturningResults(false);
    }
  }, [
    generationTask,
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

  const generationRelations = useMemo(() => nodes.flatMap((child) => {
    if (!child.parentVersionId) return [];
    const parent = nodes.find((candidate) => candidate.versionId === child.parentVersionId);
    if (!parent) return [];
    const relation = buildCanvasRelation(parent, child);
    return [{
      id: `${parent.id}-${child.id}`,
      points: relation.points
    }];
  }), [nodes]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#canvas-main">跳到画布</a>

      <aside className="tool-rail" aria-label="画布工具">
        <div className="tool-button-grid tool-command-grid">
          <RailCommandButton glyph="←" label="项目" onClick={() => window.location.reload()} />
          <RailCommandButton glyph="□" label="整理" disabled={nodes.length < 2} onClick={tidyFrames} />
        </div>
        <div className="tool-rail-divider" aria-hidden="true" />
        <div className="tool-button-grid">
          <ToolButton active={tool === "text"} label="文字" shortcut="T" onClick={() => setTool((current) => current === "text" ? "select" : "text")} />
          <ToolButton active={tool === "arrow"} label="箭头" shortcut="A" onClick={() => setTool((current) => current === "arrow" ? "select" : "arrow")} />
          <ToolButton active={tool === "freehand"} label="画笔" shortcut="P" onClick={() => setTool((current) => current === "freehand" ? "select" : "freehand")} />
          <ToolButton active={tool === "rectangle"} label="框选" shortcut="R" onClick={() => setTool((current) => current === "rectangle" ? "select" : "rectangle")} />
        </div>
      </aside>

      <main
        id="canvas-main"
        className="canvas-region"
        data-middle-panning={middlePanning || undefined}
        ref={canvasRef}
        aria-label="无限画布"
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
            if (tool === "select") {
              if (event.target === event.target.getStage()) {
                setSelectedId(null);
                setSelectedAnnotationId(null);
              }
              return;
            }
            beginAnnotation();
          }}
          onMouseMove={continueAnnotation}
          onMouseUp={() => {
            if (endMiddlePan()) return;
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
                selected={selectedId === node.id && !selectedAnnotationId}
                selectable={tool === "select"}
                viewportScale={viewport.scale}
                roleLabel={
                  structureBaseId === node.id
                    ? "01 结构基准"
                    : styleReferenceId === node.id
                      ? "02 风格参考"
                      : undefined
                }
                register={(instance) => {
                  if (instance) nodeRefs.current.set(node.id, instance);
                  else nodeRefs.current.delete(node.id);
                }}
                onSelect={() => {
                  setSelectedId(node.id);
                  setSelectedAnnotationId(null);
                }}
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
                onSelect={() => setSelectedAnnotationId(annotation.id)}
                onEdit={() => editTextAnnotation(annotation)}
                onChange={updateAnnotation}
              />
            ))}
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

        <div className="canvas-notice" data-tone={serviceState === "offline" ? "error" : "info"}>
          <span>{notice}</span>
          {serviceState === "offline" && <button onClick={() => void connectService()}>重新连接</button>}
        </div>
      </main>

      <aside className="inspector" aria-label="属性与任务">
        <section className="role-section compact-section">
          <div className="section-heading">
            <span>任务角色</span>
            <small>{selectedNode ? "当前图片" : "先选择图片"}</small>
          </div>
          <p
            className="selected-file"
            data-empty={!selectedNode || undefined}
            title={selectedNode?.name}
          >
            {selectedNode?.name ?? "未选择图片"}
          </p>
          <div className="role-options" role="group" aria-label="当前图片的任务角色">
            <button
              aria-pressed={Boolean(selectedNode && structureBaseId === selectedNode.id)}
              data-active={Boolean(selectedNode && structureBaseId === selectedNode.id)}
              disabled={!selectedNode}
              onClick={() => {
                if (selectedNode) assignReferenceRole("structure-base", selectedNode.id);
              }}
            >
              <b>01</b>
              <span>{generationMode === "reference-edit" ? "结构基准" : "内容参考"}</span>
            </button>
            <button
              aria-pressed={Boolean(selectedNode && styleReferenceId === selectedNode.id)}
              data-active={Boolean(selectedNode && styleReferenceId === selectedNode.id)}
              disabled={!selectedNode}
              onClick={() => {
                if (selectedNode) assignReferenceRole("style-reference", selectedNode.id);
              }}
            >
              <b>02</b>
              <span>风格参考</span>
            </button>
          </div>
        </section>

        <section className="prompt-section compact-section">
          <div className="task-heading">
            <div>
              <p className="section-kicker">PROMPT LIBRARY</p>
              <h3>提示词仓库</h3>
            </div>
            <span>{promptLibrary.length} 条</span>
          </div>

          <div className="prompt-library">
            <details className="prompt-picker" ref={promptPickerRef}>
              <summary aria-label="选择复用提示词">
                <span>{promptLibrary.find((item) => item.id === selectedPromptId)?.title ?? "选择已保存提示词"}</span>
                <i aria-hidden="true">⌄</i>
              </summary>
              <div role="listbox" aria-label="已保存提示词">
                {promptLibrary.length ? promptLibrary.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={item.id === selectedPromptId}
                    onClick={() => applyPromptTemplate(item.id)}
                  >
                    {item.title}
                  </button>
                )) : (
                  <p>暂无已保存提示词</p>
                )}
              </div>
            </details>
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

          <label className="task-instruction">
            <span>修改要求</span>
            <textarea
              value={taskInstruction}
              rows={6}
              maxLength={2000}
              placeholder="只写需要改变的内容；建筑结构保护规则会自动补入最终提示词。"
              onChange={(event) => {
                setTaskInstruction(event.target.value);
                setRevision((current) => current + 1);
              }}
            />
          </label>

          {taskPreview.missing.length > 0 && (
            <p className="task-missing">待补：{taskPreview.missing.join("、")}</p>
          )}
          <details className="prompt-preview">
            <summary>
              查看最终提示词
              <small>{taskPreview.prompt.length.toLocaleString("zh-CN")} 字</small>
            </summary>
            <pre>{taskPreview.prompt || "指定结构基准并填写修改要求后生成预览。"}</pre>
          </details>

          {generationActive && generationTask ? (
            <p className="generation-progress" data-needs-user={generationTask.status === "needs-user" || undefined}>
              {generationTask.status === "needs-user"
                ? "登录或网页验证需要处理，系统已切换到 ChatGPT。"
                : "后台生成中，完成后结果会自动回到画布。"}
            </p>
          ) : (
            <>
              <button
                className="task-create"
                disabled={!taskPreview.ready || !automationReady || creatingTask}
                onClick={() => void createTask()}
              >
                {creatingTask
                  ? "正在创建…"
                  : !automationReady
                    ? "请重新加载自动扩展"
                    : taskPreview.ready
                      ? "一键生成并自动回图"
                      : "任务输入未完整"}
              </button>
              <p className="submission-boundary">生成在后台完成；只有登录失效或网页验证时才切换到 ChatGPT。</p>
            </>
          )}
        </section>

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
            <div className="section-heading"><span>独立导出</span><small>{annotations.length} 条批注</small></div>
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
              || !automationReady
              || creatingTask
              || Boolean(generationTask && !isTerminalStatus(generationTask.status))
            }
            onClick={() => void createTask()}
          >
            {creatingTask
              ? "正在创建…"
              : !automationReady
                ? "请重新加载自动扩展"
              : generationTask && !isTerminalStatus(generationTask.status)
                  ? TASK_STATUS_LABELS[generationTask.status]
                  : taskPreview.ready
                  ? "一键生成并自动回图"
                  : "任务输入未完整"}
          </button>
          <p className="submission-boundary">点击一次后自动打开 ChatGPT、上传、提交、收集并回图；登录或网页验证异常时才暂停人工处理。</p>
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

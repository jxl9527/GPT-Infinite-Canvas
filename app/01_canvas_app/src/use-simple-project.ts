import { useCallback, useEffect, useRef, useState } from "react";
import type { GenerationTask } from "@gpt-canvas/shared";
import { BridgeApiError, bindCanvasProject, cancelGenerationTask, createGenerationTask, importCanvasAsset, listGenerationTasks, preserveCanvasConflictDraft, readCanvasProject, readFileAsDataUrl, readGenerationResultAsDataUrl, saveCanvasAssetDerivatives, saveCanvasProject, saveGeneratedAsset } from "./bridge-client";
import { createImageDerivatives } from "./image-derivatives";
import { EMPTY_CANVAS_WORKFLOW, type CanvasProjectDocument } from "./project-state";
import { appendImage, batchFinished, emptySimplePreferences, makeSimpleBatch, nextSimpleItem, simpleTaskInput } from "./simple-state";
import type { CanvasTextCard } from "./text-card";
import { automationExtensionVersionSupported } from "./canvas-automation";

export function useSimpleProject(projectId: string, projectName: string) {
  const [document, setDocument] = useState<CanvasProjectDocument | null>(null);
  const ref = useRef<CanvasProjectDocument | null>(null);
  const [notice, setNotice] = useState(""); const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false); const [tasks, setTasks] = useState<GenerationTask[]>([]);
  const [ready, setReady] = useState(false); const [loadingError, setLoadingError] = useState("");
  const saved = useRef(-1); const queue = useRef<Promise<unknown>>(Promise.resolve());
  const alive = useRef(true); const conflict = useRef(false); const started = useRef(new Map<string, number>());
  type HistoryFrame = { nodes: CanvasProjectDocument["canvas"]["nodes"]; textCards: CanvasTextCard[] };
  const history = useRef<{ before: HistoryFrame[]; after: HistoryFrame[] }>({ before: [], after: [] });
  const frame = (value: CanvasProjectDocument): HistoryFrame => structuredClone({ nodes: value.canvas.nodes, textCards: value.workflow?.textCards ?? [] });

  const update = useCallback((transform: (current: CanvasProjectDocument) => CanvasProjectDocument, remember = false) => {
    const current = ref.current;
    if (!current || conflict.current) return;
    const next = transform(structuredClone(current));
    if (remember) {
      history.current.before.push(frame(current));
      history.current.before = history.current.before.slice(-50); history.current.after = [];
    }
    next.revision = current.revision + 1; next.updatedAt = new Date().toISOString();
    ref.current = next; setDocument(next);
  }, []);

  const save = useCallback(async () => {
    const operation = queue.current.catch(() => undefined).then(async () => {
      const snapshot = ref.current;
      if (!snapshot || snapshot.revision <= saved.current) return;
      if (conflict.current) throw new Error("请先处理保存冲突");
      setSaving(true);
      try {
        const result = await saveCanvasProject(snapshot, false, saved.current);
        saved.current = result.project.revision; setSaveError("");
      } catch (error) {
        if (error instanceof BridgeApiError && (error.code === "INVALID_TRANSITION" || error.code === "TASK_LOCKED")) conflict.current = true;
        setSaveError((error as Error).message); throw error;
      } finally { setSaving(false); }
    });
    queue.current = operation;
    return operation;
  }, []);

  useEffect(() => {
    alive.current = true; bindCanvasProject(projectId);
    let cancelled = false;
    void readCanvasProject().then((value) => {
      if (!alive.current || cancelled) return;
      const now = new Date().toISOString();
      const initial = value ?? { schemaVersion: "2.0" as const, projectId: `project_${crypto.randomUUID()}` as const, title: projectName, createdAt: now, updatedAt: now, revision: 0, canvas: { viewport: { x: 0, y: 0, scale: 1 }, nodes: [] }, assets: [], versions: [], taskLinks: [], workflow: structuredClone(EMPTY_CANVAS_WORKFLOW) };
      saved.current = value?.revision ?? -1;
      if (!initial.simple) { initial.simple = emptySimplePreferences(); if (value) initial.revision++; }
      ref.current = initial; setDocument(initial); setReady(true);
    }).catch((error: Error) => setLoadingError(error.message));
    return () => { cancelled = true; alive.current = false; bindCanvasProject(null); };
  }, [projectId, projectName]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => void save().catch(() => undefined), 600);
    return () => clearTimeout(timer);
  }, [document?.revision, ready, save]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (ref.current && ref.current.revision > saved.current) { event.preventDefault(); event.returnValue = ""; } };
    const hidden = () => { if (window.document.visibilityState === "hidden") void save().catch(() => undefined); };
    window.addEventListener("beforeunload", beforeUnload); window.document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("beforeunload", beforeUnload); window.document.removeEventListener("visibilitychange", hidden); };
  }, [save]);

  const extensionReady = () => automationExtensionVersionSupported(window.document.documentElement.getAttribute("data-gpt-canvas-extension-version"), "1.6.0");
  const sendToExtension = (task: GenerationTask, force = false) => {
    if (!extensionReady()) return;
    if (!force && Date.now() - (started.current.get(task.id) ?? 0) < 30_000) return;
    started.current.set(task.id, Date.now());
    window.document.documentElement.setAttribute("data-gpt-canvas-task-id", task.id);
    window.document.documentElement.setAttribute("data-gpt-canvas-focus-task", String(force));
    window.dispatchEvent(new Event("gpt-canvas-run-task"));
  };

  useEffect(() => {
    if (!ready) return;
    let polling = false;
    const tick = async () => {
      if (polling || !alive.current || conflict.current) return;
      polling = true;
      try {
        await navigator.locks.request(`simple-render-${projectId}`, { ifAvailable: true }, async (lock) => {
          if (!lock || !alive.current || conflict.current) return;
          await save();
          const known = await listGenerationTasks(); if (!alive.current) return; setTasks(known);
          const batch = ref.current?.simple?.batch;
          if (!batch || batchFinished(batch)) return;
          for (const task of known.filter((entry) => entry.simpleRender?.batchId === batch.id)) {
            const item = ref.current?.simple?.batch?.items.find((entry) => entry.id === task.simpleRender?.itemId);
            if (!item || !ref.current || !alive.current) continue;
            if (item.taskId !== task.id) update((doc) => { const row = doc.simple!.batch!.items.find((entry) => entry.id === item.id)!; row.taskId = task.id; row.status = "running"; return doc; });
            if (task.status === "completed" && item.status !== "completed") {
              if (!task.results.length) throw new Error("任务已结束但未返回图片，请在网页检查结果");
              for (const result of task.results) {
                const versionId = `version_${task.id}_${result.id}` as const;
                if (ref.current!.versions.some((entry) => entry.id === versionId)) continue;
                const dataUrl = await readGenerationResultAsDataUrl(task.id, result.id);
                const imported = await saveGeneratedAsset(`${item.sourceName.replace(/\.[^.]+$/, "")}_生成.png`, dataUrl);
                const derivatives = await createImageDerivatives(dataUrl);
                await saveCanvasAssetDerivatives(imported.asset.id, derivatives.displayDataUrl, derivatives.thumbnailDataUrl);
                if (!alive.current) return;
                update((doc) => appendImage(doc, imported.asset, `${item.sourceName.replace(/\.[^.]+$/, "")}_生成`, { versionId, taskId: task.id, parentVersionId: item.sourceVersionId as `version_${string}` }));
                history.current = { before: [], after: [] };
              }
              update((doc) => {
                const row = doc.simple!.batch!.items.find((entry) => entry.id === item.id)!;
                row.status = "completed"; row.resultVersionIds = task.results.map((result) => `version_${task.id}_${result.id}`); row.error = "";
                const parent = doc.versions.find((entry) => entry.id === row.sourceVersionId);
                const asset = doc.assets.find((entry) => entry.id === parent?.assetId);
                const resultVersion = doc.versions.find((entry) => entry.id === row.resultVersionIds[0]);
                const output = doc.assets.find((entry) => entry.id === resultVersion?.assetId);
                if (asset && output && Math.abs(asset.original.width / asset.original.height - output.original.width / output.original.height) > .03) row.error = "返回比例与底图不同，已保留完整原图，请检查";
                return doc;
              });
              await save();
            } else if ((task.status === "failed" || task.status === "cancelled") && item.status !== "failed" && item.status !== "cancelled") {
              update((doc) => { const row = doc.simple!.batch!.items.find((entry) => entry.id === item.id)!; row.status = task.status === "cancelled" ? "cancelled" : "failed"; row.error = task.handoff?.reason || "任务未完成，可检查网页或重试"; doc.simple!.batch!.paused = true; return doc; });
            } else if (task.status === "needs-user" && item.error !== task.handoff?.reason) {
              update((doc) => { const row = doc.simple!.batch!.items.find((entry) => entry.id === item.id)!; row.error = task.handoff?.reason || "请检查对应网页"; doc.simple!.batch!.paused = true; return doc; });
            }
            // Rebinding a live task resumes observation, never resubmits it.
            if (task.status === "queued" || task.status === "opening-chat" || (task.submittedAt && !["completed", "cancelled", "failed", "needs-user"].includes(task.status) && !started.current.has(task.id))) sendToExtension(task);
          }
          await save();
          const current = ref.current; const run = current?.simple?.batch;
          if (!current || !run || !extensionReady()) return;
          const next = nextSimpleItem(run, known);
          if (!next) return;
          try {
            const task = await createGenerationTask(simpleTaskInput(current, run, next, projectId));
            update((doc) => { const row = doc.simple!.batch!.items.find((entry) => entry.id === next.id)!; row.taskId = task.id; row.status = "running"; return doc; });
            await save(); sendToExtension(task);
          } catch (error) {
            if (!(error instanceof BridgeApiError && error.code === "TASK_LOCKED")) throw error;
          }
        });
      } catch (error) { if (alive.current) setNotice((error as Error).message); }
      finally { polling = false; }
    };
    void tick(); const timer = window.setInterval(() => void tick(), 1800);
    return () => clearInterval(timer);
  }, [ready, projectId, save, update]);

  const importFiles = async (files: File[]) => {
    let count = 0; const failures: string[] = [];
    for (const file of files.sort((a, b) => a.name.localeCompare(b.name, "zh-CN", { numeric: true }))) {
      try {
        if (!/\.(png|jpe?g|webp)$/i.test(file.name) || file.size > 40 * 1024 * 1024) throw new Error("仅支持 40 MiB 内的 PNG、JPEG、WebP");
        const data = await readFileAsDataUrl(file);
        const { asset } = await importCanvasAsset(file, data);
        const derivatives = await createImageDerivatives(data);
        await saveCanvasAssetDerivatives(asset.id, derivatives.displayDataUrl, derivatives.thumbnailDataUrl);
        update((doc) => { const next = appendImage(doc, asset, file.name); next.simple!.selectedIds = [next.canvas.nodes.at(-1)!.id]; return next; }, true);
        await save(); count++;
      } catch (error) { failures.push(`${file.name}：${(error as Error).message}`); }
    }
    setNotice(`已导入 ${count} 张图片${failures.length ? `；${failures.join("；")}` : ""}`);
  };

  const start = async () => {
    if (!extensionReady()) throw new Error("请加载新版 1.6.0 浏览器扩展并刷新画布，首次使用需在扩展中连接本地服务");
    const doc = ref.current!;
    if (!batchFinished(doc.simple!.batch)) throw new Error("请先完成或停止当前批次");
    if (doc.workflow?.batchRun && doc.workflow.batchRun.status !== "completed") throw new Error("旧版批次尚未结束，请从设置中的旧版入口处理");
    const run = makeSimpleBatch(doc, doc.simple!.selectedIds, doc.simple!.draft, doc.simple!.concurrency);
    update((current) => { current.simple!.batch = run; return current; }); await save();
    setNotice(`已建立 ${run.items.length} 张图片的渲染批次`);
  };

  const stop = async () => { update((doc) => { const batch = doc.simple!.batch; if (batch) { batch.paused = true; for (const item of batch.items) if (item.status === "queued" || item.status === "failed") item.status = "cancelled"; } return doc; }); await save(); setNotice("已停止后续任务；已发送的图片继续生成并回收"); };
  const pause = async (paused: boolean) => { update((doc) => { if (doc.simple!.batch) doc.simple!.batch.paused = paused; return doc; }); await save(); };
  const endTracking = async (taskId: string) => { await cancelGenerationTask(taskId); setNotice("已结束本地跟踪，网页上已提交的生成不会被撤回"); };
  const retry = async (itemId: string) => {
    update((doc) => { const batch = doc.simple!.batch!; const row = batch.items.find((entry) => entry.id === itemId)!; if (row.status !== "failed" && row.status !== "cancelled") return doc; row.id = `item_${crypto.randomUUID()}`; row.status = "queued"; row.taskId = null; row.error = ""; batch.paused = false; return doc; }); await save();
  };
  const recover = async () => {
    if (!ref.current) return;
    const result = await preserveCanvasConflictDraft(ref.current);
    ref.current = { ...result.currentProject, simple: result.currentProject.simple ?? emptySimplePreferences() };
    saved.current = result.currentProject.revision; conflict.current = false; setSaveError(""); setDocument(ref.current);
    history.current = { before: [], after: [] }; setNotice("本地草稿已保存，已载入最新项目");
  };
  const undo = (redo = false) => {
    const from = redo ? history.current.after : history.current.before;
    const to = redo ? history.current.before : history.current.after;
    const previous = from.pop(); if (!previous || !ref.current) return;
    to.push(frame(ref.current)); update((doc) => { doc.canvas.nodes = previous.nodes; if (doc.workflow) doc.workflow.textCards = previous.textCards; return doc; });
  };
  return { document, ref, update, save, notice, setNotice, saveError, saving, ready, loadingError, tasks, importFiles, start, stop, pause, endTracking, retry, recover, undo, sendToExtension };
}

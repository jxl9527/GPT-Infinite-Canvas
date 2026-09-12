import { useEffect, useRef, useState } from "react";
import { Stage, Layer, Rect, Text, Group, Image as KonvaImage, Line, Arrow } from "react-konva";
import Konva from "konva";
import { exportSelectedImages, getCurrentBridgeToken, readCanvasAssetAsObjectUrl, releaseCanvasAssetObjectUrl, selectProjectFolder } from "./bridge-client";
import type { CanvasProjectNode } from "./project-state";
import { batchFinished, simpleTaskLabel } from "./simple-state";
import { useSimpleProject } from "./use-simple-project";
import { copyPromptText } from "./PromptGallery";
import { buildCanvasRelation } from "./canvas-layout";
import type { AnnotationState } from "./annotation-model";

let imageLoads = 0;
const imageQueue: Array<() => void> = [];
async function withImageSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (imageLoads >= 4) await new Promise<void>((resolve) => imageQueue.push(resolve));
  else imageLoads++;
  try { return await operation(); }
  finally { const next = imageQueue.shift(); if (next) next(); else imageLoads--; }
}
function useAssetImage(assetId: string, original = false) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    let cancelled = false; let url = "";
    void withImageSlot(async () => {
      if (cancelled) return;
      url = await readCanvasAssetAsObjectUrl(assetId, original ? "original" : "display");
      if (cancelled) { releaseCanvasAssetObjectUrl(url); return; }
      const element = new window.Image();
      await new Promise<void>((resolve, reject) => { element.onload = () => resolve(); element.onerror = () => reject(new Error("图片读取失败")); element.src = url; });
      if (!cancelled) setImage(element);
    }).catch(() => { if (!cancelled) setImage(null); });
    return () => { cancelled = true; if (url) releaseCanvasAssetObjectUrl(url); };
  }, [assetId, original]);
  return image;
}
function ImageNode({ node, assetId, selected, draggable, onSelect, onMove, onPreview }: {
  node: CanvasProjectNode; assetId: string; selected: boolean; draggable: boolean;
  onSelect(additive: boolean): void; onMove(dx: number, dy: number): void; onPreview(): void;
}) {
  const image = useAssetImage(assetId);
  const scale = image ? Math.min(node.width / image.naturalWidth, node.height / image.naturalHeight) : 1;
  const width = image ? image.naturalWidth * scale : node.width;
  const height = image ? image.naturalHeight * scale : node.height;
  return <Group x={node.x} y={node.y} draggable={draggable && !node.locked}
    onMouseDown={(e) => { if (!draggable) return; e.cancelBubble = true; if (!selected && !e.evt.shiftKey && !e.evt.ctrlKey) onSelect(false); }}
    onClick={(e) => { e.cancelBubble = true; if (e.evt.shiftKey || e.evt.ctrlKey) onSelect(true); else onSelect(false); }}
    onTap={() => onSelect(false)} onDblClick={onPreview}
    onDragEnd={(e) => { e.cancelBubble = true; const dx = e.target.x() - node.x; const dy = e.target.y() - node.y; e.target.position({ x: node.x, y: node.y }); onMove(dx, dy); }}>
    <Rect width={node.width} height={node.height} fill="#e8e8e2" stroke={selected ? "#425c48" : "#cdd1c8"} strokeWidth={selected ? 3 : 1} />
    {image ? <KonvaImage image={image} x={(node.width - width) / 2} y={(node.height - height) / 2} width={width} height={height} /> : <Text width={node.width} y={node.height / 2 - 10} text="正在载入图片…" align="center" fill="#68736a" fontSize={14} />}
    <Text y={node.height + 12} width={node.width} text={String(node.payload.name ?? "图片")} fontFamily="Microsoft YaHei UI" fill="#515b50" fontSize={15} ellipsis wrap="none" />
    {selected && <Rect width={node.width} height={node.height} stroke="#425c48" strokeWidth={3} listening={false} />}
  </Group>;
}
function Preview({ assetId, name, onClose }: { assetId: string; name: string; onClose(): void }) {
  const image = useAssetImage(assetId, true);
  useEffect(() => { const listener = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", listener); return () => window.removeEventListener("keydown", listener); }, [onClose]);
  return <div className="sg-preview" role="dialog" aria-modal="true" aria-label="图片原尺寸预览"><header><span>{name}</span><button autoFocus onClick={onClose}>关闭预览 ×</button></header>{image ? <img src={image.src} alt={name} /> : <p>正在读取完整图片…</p>}</div>;
}

export function SimpleCanvas({ projectId, projectName, onGallery, onProjects, hidden }: {
  projectId: string; projectName: string; onGallery(): void; onProjects(): void; hidden: boolean;
}) {
  const model = useSimpleProject(projectId, projectName);
  const doc = model.document; const prefs = doc?.simple;
  const host = useRef<HTMLDivElement>(null); const stage = useRef<Konva.Stage>(null);
  const fileInput = useRef<HTMLInputElement>(null); const folderInput = useRef<HTMLInputElement>(null);
  const [size, setSize] = useState({ width: 1000, height: 700 });
  const [mode, setMode] = useState<"select" | "pan">("select"); const [space, setSpace] = useState(false);
  const [settings, setSettings] = useState(false); const [exporting, setExporting] = useState(false); const [importing, setImporting] = useState(false);
  const [exportPath, setExportPath] = useState(""); const [preview, setPreview] = useState<{ assetId: string; name: string } | null>(null);
  const [editText, setEditText] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ x: number; y: number; endX: number; endY: number } | null>(null);
  const [connection, setConnection] = useState("");
  const run = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (e) { model.setNotice((e as Error).message); } };
  const updatePreferences = (change: Partial<NonNullable<typeof prefs>>) => model.update((current) => { Object.assign(current.simple!, change); return current; });
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(([entry]) => { if (entry && entry.contentRect.width) setSize({ width: entry.contentRect.width, height: entry.contentRect.height }); });
    observer.observe(host.current); return () => observer.disconnect();
  }, [Boolean(doc), hidden]);
  useEffect(() => {
    const report = () => setConnection(window.document.documentElement.getAttribute("data-gpt-canvas-extension-version") || "");
    report(); window.addEventListener("gpt-canvas-automation-status", report);
    const status = () => { const root = window.document.documentElement; if (root.getAttribute("data-gpt-canvas-automation-status") === "error") model.setNotice(root.getAttribute("data-gpt-canvas-automation-message") || "扩展连接失败"); };
    window.addEventListener("gpt-canvas-automation-status", status);
    return () => { window.removeEventListener("gpt-canvas-automation-status", report); window.removeEventListener("gpt-canvas-automation-status", status); };
  }, []);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (hidden || e.target instanceof HTMLElement && (e.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName))) return;
      if (e.code === "Space") { e.preventDefault(); setSpace(true); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); model.undo(e.shiftKey); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); model.undo(true); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); model.update((current) => { current.simple!.selectedIds = current.canvas.nodes.filter((n) => n.type === "image").map((n) => n.id); return current; }); }
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); model.update((current) => { current.canvas.nodes = current.canvas.nodes.filter((n) => !current.simple!.selectedIds.includes(n.id)); current.simple!.selectedIds = []; return current; }, true); }
      const delta: Record<string, [number, number]> = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] };
      if (delta[e.key]) { e.preventDefault(); const [x,y] = delta[e.key]!; moveSelected(x * (e.shiftKey ? 10 : 1), y * (e.shiftKey ? 10 : 1)); }
    };
    const up = () => setSpace(false);
    window.addEventListener("keydown", down); window.addEventListener("keyup", up); window.addEventListener("blur", up);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", up); };
  }, [hidden, model.update]);

  const moveSelected = (dx: number, dy: number, fallback?: string) => model.update((current) => {
    const ids = current.simple!.selectedIds.length ? current.simple!.selectedIds : fallback ? [fallback] : [];
    for (const node of current.canvas.nodes) if (ids.includes(node.id) && !node.locked) { node.x += dx; node.y += dy; }
    return current;
  }, true);
  const fit = () => model.update((current) => {
    const nodes = current.canvas.nodes.filter((n) => n.type === "image"); if (!nodes.length) return current;
    const minX = Math.min(...nodes.map((n) => n.x)); const minY = Math.min(...nodes.map((n) => n.y));
    const width = Math.max(...nodes.map((n) => n.x + n.width)) - minX; const height = Math.max(...nodes.map((n) => n.y + n.height + 32)) - minY;
    const scale = Math.min(1, (size.width - 100) / Math.max(1, width), (size.height - 100) / Math.max(1, height));
    current.canvas.viewport = { x: (size.width - width * scale) / 2 - minX * scale, y: (size.height - height * scale) / 2 - minY * scale, scale: Math.max(.03, scale) }; return current;
  });
  const importFiles = async (files: File[]) => { setImporting(true); try { await model.importFiles(files); } finally { setImporting(false); } };
  const doExport = async () => {
    setExporting(true);
    try { await model.save(); const current = model.ref.current!; const rows = current.canvas.nodes.filter((n) => current.simple!.selectedIds.includes(n.id)).map((n) => ({ versionId: String(n.payload.imageVersionId), assetId: current.versions.find((v) => v.id === n.payload.imageVersionId)!.assetId, name: String(n.payload.name ?? "图片") }));
      const result = await exportSelectedImages(exportPath, rows); model.setNotice(`已导出 ${result.exported} 张至 ${exportPath}${result.failed ? `；${result.failed} 张失败：${result.records.filter((r) => r.error).map((r) => r.error).join("；")}` : ""}`);
    } finally { setExporting(false); }
  };

  if (!doc) return <section className="sg-empty"><h2>{model.loadingError || "正在打开画布…"}</h2>{model.loadingError && <button onClick={onProjects}>返回项目</button>}</section>;
  const selected = doc.canvas.nodes.filter((n) => prefs!.selectedIds.includes(n.id) && n.type === "image");
  const viewport = doc.canvas.viewport;
  const visible = doc.canvas.nodes.filter((node) => node.visible !== false && node.x * viewport.scale + viewport.x + node.width * viewport.scale > -250 && node.y * viewport.scale + viewport.y + node.height * viewport.scale > -250 && node.x * viewport.scale + viewport.x < size.width + 250 && node.y * viewport.scale + viewport.y < size.height + 250);
  const batch = prefs!.batch;
  const active = !batchFinished(batch);
  const world = () => { const pointer = stage.current?.getPointerPosition(); return pointer ? { x: (pointer.x - viewport.x) / viewport.scale, y: (pointer.y - viewport.y) / viewport.scale } : null; };
  const selectedText = doc.workflow?.textCards.find((card) => card.id === editText);
  return <section className="sg-canvas-page" hidden={hidden}>
    <header className="sg-canvas-bar"><button onClick={() => void run(async () => { await model.save(); if (active) throw new Error("请先完成或停止当前批次，再切换项目"); onProjects(); })}>← 项目</button><h1>{projectName}</h1><span className="sg-save-state">{model.saveError ? "保存需处理" : model.saving ? "保存中…" : "自动保存"}</span>
      <div className="sg-bar-actions"><button onClick={onGallery}>提示词库</button><button disabled={importing} onClick={() => fileInput.current?.click()}>{importing ? "导入中…" : "＋ 导入图片"}</button><button onClick={() => { setSettings(true); }}>导出 / 设置</button></div></header>
    <input hidden ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={(e) => { void run(() => importFiles(Array.from(e.target.files ?? []))); e.target.value = ""; }} />
    <input hidden ref={folderInput} type="file" multiple {...({ webkitdirectory: "" } as Record<string,string>)} onChange={(e) => { void run(() => importFiles(Array.from(e.target.files ?? []))); e.target.value = ""; }} />
    {(model.notice || model.saveError) && <div className={model.saveError ? "sg-message sg-error" : "sg-message"} role={model.saveError ? "alert" : "status"}>{model.saveError || model.notice}{model.saveError && <><button onClick={() => void run(model.save)}>重试保存</button><button onClick={() => void run(model.recover)}>保存本地草稿并载入最新</button></>}</div>}
    <div className={`sg-canvas-layout ${(selected.length || active || settings || selectedText) ? "sg-has-panel" : ""}`}>
      <div ref={host} className="sg-stage" tabIndex={0} aria-label="图片画布，空白处拖框选择，空格拖动平移，滚轮缩放" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void run(() => importFiles(Array.from(e.dataTransfer.files))); }}>
        <div className="sg-canvas-tools"><button aria-pressed={mode === "select"} onClick={() => setMode("select")}>选择</button><button aria-pressed={mode === "pan"} onClick={() => setMode("pan")}>平移</button><span /><button onClick={() => model.undo()}>撤销</button><button onClick={() => model.undo(true)}>重做</button><button onClick={fit}>适合画面</button></div>
        {!doc.canvas.nodes.length && <div className="sg-canvas-empty"><p className="sg-eyebrow">一张底图，无限可能</p><h2>把图片放在这里</h2><p>拖入图片，或选择已有文件。选图后粘贴提示词即可渲染。</p><button className="sg-primary" onClick={() => fileInput.current?.click()}>导入第一张图片</button><button onClick={() => folderInput.current?.click()}>导入整个文件夹</button></div>}
        <Stage ref={stage} width={size.width} height={size.height} x={viewport.x} y={viewport.y} scaleX={viewport.scale} scaleY={viewport.scale} draggable={mode === "pan" || space}
          onWheel={(e) => { e.evt.preventDefault(); const pointer = stage.current?.getPointerPosition(); if (!pointer) return; const scale = Math.min(8, Math.max(.03, viewport.scale * (e.evt.deltaY > 0 ? .9 : 1 / .9))); model.update((current) => { current.canvas.viewport = { scale, x: pointer.x - (pointer.x - viewport.x) / viewport.scale * scale, y: pointer.y - (pointer.y - viewport.y) / viewport.scale * scale }; return current; }); }}
          onDragEnd={(e) => { if (e.target !== stage.current) return; model.update((current) => { current.canvas.viewport.x = e.target.x(); current.canvas.viewport.y = e.target.y(); return current; }); }}
          onMouseDown={(e) => { if (e.target !== stage.current || mode === "pan" || space) return; const point = world(); if (point) setSelection({ ...point, endX: point.x, endY: point.y }); }}
          onMouseMove={() => { const point = world(); if (selection && point) setSelection({ ...selection, endX: point.x, endY: point.y }); }}
          onMouseUp={(e) => { if (!selection) return; const minX = Math.min(selection.x, selection.endX); const minY = Math.min(selection.y, selection.endY); const maxX = Math.max(selection.x, selection.endX); const maxY = Math.max(selection.y, selection.endY); const ids = doc.canvas.nodes.filter((n) => n.type === "image" && n.x < maxX && n.x + n.width > minX && n.y < maxY && n.y + n.height > minY).map((n) => n.id); updatePreferences({ selectedIds: e.evt.shiftKey ? [...new Set([...prefs!.selectedIds, ...ids])] : ids }); setSelection(null); }}>
          <Layer>
            {visible.filter((n) => n.type === "image").map((node) => { const version = doc.versions.find((v) => v.id === node.payload.imageVersionId); const parent = doc.canvas.nodes.find((n) => n.payload.imageVersionId === version?.parentVersionId); return parent ? <Line key={`link-${node.id}`} points={buildCanvasRelation(parent, node).points} bezier stroke="#a8b1a4" strokeWidth={1.5} listening={false} /> : null; })}
            {visible.map((node) => { const version = doc.versions.find((v) => v.id === node.payload.imageVersionId);
              if (node.type === "image" && version) return <ImageNode key={node.id} node={node} assetId={version.assetId} selected={prefs!.selectedIds.includes(node.id)} draggable={mode === "select" && !space} onPreview={() => setPreview({ assetId: version.assetId, name: String(node.payload.name) })} onSelect={(additive) => updatePreferences({ selectedIds: additive ? prefs!.selectedIds.includes(node.id) ? prefs!.selectedIds.filter((id) => id !== node.id) : [...prefs!.selectedIds, node.id] : [node.id] })} onMove={(dx,dy) => moveSelected(dx,dy,node.id)} />;
              const a = node.payload.annotation as AnnotationState | undefined; if (!a) return null;
              return <Group key={node.id} x={a.x} y={a.y} draggable={mode === "select"} onDragEnd={(e) => { model.update((current) => { const n = current.canvas.nodes.find((n) => n.id === node.id)!; n.x = e.target.x(); n.y = e.target.y(); const annotation = n.payload.annotation as AnnotationState; annotation.x = n.x; annotation.y = n.y; return current; }, true); }}>
                {a.type === "text" ? <Text text={a.text} width={a.width} fontSize={a.fontSize} fill={a.color} /> : a.type === "rectangle" ? <Rect width={a.width} height={a.height} stroke={a.color} strokeWidth={2} /> : a.type === "arrow" ? <Arrow points={a.points} fill={a.color} stroke={a.color} /> : <Line points={a.points} stroke={a.color} strokeWidth={2} />}</Group>;
            })}
            {doc.workflow?.textCards.map((card) => <Group key={card.id} x={card.x} y={card.y} draggable={mode === "select"} onDblClick={() => setEditText(card.id)} onDragEnd={(e) => model.update((current) => { const c = current.workflow!.textCards.find((c) => c.id === card.id)!; c.x = e.target.x(); c.y = e.target.y(); return current; }, true)}><Rect width={card.width} height={card.height} fill="#faf7ec" stroke="#d5ccae" /><Text x={16} y={16} width={card.width-32} text={card.title} fontSize={18} fill="#4d5146" /><Text x={16} y={50} width={card.width-32} height={card.height-66} text={card.text} fontSize={14} fill="#51584c" /></Group>)}
            {batch?.items.filter((item) => !["completed", "cancelled"].includes(item.status)).map((item) => { const source = doc.canvas.nodes.find((n) => n.payload.imageVersionId === item.sourceVersionId); if (!source) return null; const siblings = doc.canvas.nodes.filter((n) => doc.versions.find((v) => v.id === n.payload.imageVersionId)?.parentVersionId === item.sourceVersionId); const y = siblings.length ? Math.max(...siblings.map((n) => n.y + n.height)) + 48 : source.y; return <Group key={item.id} x={source.x+source.width+96} y={y}><Rect width={source.width} height={source.height} fill="#e4e9e0" stroke="#b0bba8" dash={[7,7]} /><Text y={source.height/2-10} width={source.width} text={simpleTaskLabel(model.tasks.find((t) => t.id === item.taskId), item)} align="center" fontSize={18} fill="#55664f" /></Group>; })}
            {selection && <Rect x={Math.min(selection.x,selection.endX)} y={Math.min(selection.y,selection.endY)} width={Math.abs(selection.endX-selection.x)} height={Math.abs(selection.endY-selection.y)} fill="rgba(71,103,72,.12)" stroke="#476748" strokeWidth={1/viewport.scale} listening={false} />}
          </Layer>
        </Stage>
        <div className="sg-canvas-bottom"><span>{Math.round(viewport.scale*100)}%</span><span>空格平移 · 滚轮缩放 · 双击看原图</span><details><summary>图片列表（{doc.canvas.nodes.filter((n) => n.type === "image").length}）</summary><div>{doc.canvas.nodes.filter((n) => n.type === "image").map((node) => <button key={node.id} aria-pressed={prefs!.selectedIds.includes(node.id)} onClick={() => updatePreferences({ selectedIds: [node.id] })}>{String(node.payload.name)}</button>)}</div></details></div>
      </div>
      {(selected.length > 0 || active || settings || selectedText) && <aside className="sg-render-panel" aria-label="渲染面板">
        {settings ? <><div className="sg-panel-title"><h2>画布设置</h2><button onClick={() => setSettings(false)}>关闭</button></div><label>同时生成<select value={prefs!.concurrency} disabled={active} onChange={(e) => updatePreferences({ concurrency: Number(e.target.value) as 1|2 })}><option value={2}>两张图片</option><option value={1}>一张图片</option></select></label><p className="sg-small">每张图片使用独立 ChatGPT 网页；提交依次进行，生成时间可以重叠。</p><hr /><h3>导出所选图片</h3><label>保存文件夹<input value={exportPath} onChange={(e) => setExportPath(e.target.value)} placeholder="选择文件夹或粘贴完整路径" /></label><button onClick={() => void run(async () => { const path = await selectProjectFolder(); if (path) setExportPath(path); })}>选择文件夹</button><button className="sg-primary" disabled={!selected.length || !exportPath || exporting} onClick={() => void run(doExport)}>{exporting ? "导出中…" : `导出 ${selected.length} 张`}</button><hr /><details><summary>连接与兼容</summary><p>浏览器扩展：{connection || "未连接"}</p><button onClick={() => void run(async () => { await copyPromptText(await getCurrentBridgeToken()); model.setNotice("连接令牌已复制，请粘贴到扩展设置"); })}>复制本地连接令牌</button><button onClick={() => folderInput.current?.click()}>导入文件夹</button><button onClick={() => void run(async () => { await model.save(); if (active) throw new Error("请先完成当前批次再进入旧版"); const url = new URL(location.href); url.searchParams.set("legacy", "1"); location.assign(url.href); })}>打开旧版兼容工作台</button></details></>
          : selectedText ? <><div className="sg-panel-title"><h2>{selectedText.title}</h2><button onClick={() => setEditText(null)}>关闭</button></div><textarea aria-label="历史文字卡内容" className="sg-text-edit" value={selectedText.text} onChange={(e) => model.update((current) => { current.workflow!.textCards.find((c) => c.id === selectedText.id)!.text = e.target.value; return current; }, true)} /><button onClick={() => void run(() => copyPromptText(selectedText.text))}>复制文字</button></>
          : <><p className="sg-eyebrow">图片渲染</p><h2>{selected.length ? `已选择 ${selected.length} 张图片` : "渲染进行中"}</h2>{selected.length > 0 && <><p className="sg-selected-names">{selected.slice(0,3).map((n) => String(n.payload.name)).join(" / ")}{selected.length > 3 ? " …" : ""}</p><label htmlFor="simple-prompt">提示词<button className="sg-inline-link" onClick={onGallery}>从图库复制 ↗</button></label><textarea id="simple-prompt" placeholder="在这里粘贴提示词，也可以直接写下你的要求。" maxLength={20000} value={prefs!.draft} onChange={(e) => updatePreferences({ draft: e.target.value })} /><div className="sg-prompt-meta"><span>{prefs!.draft.length} / 20000</span><span>{prefs!.concurrency === 2 ? "双任务" : "单任务"} · 每图一个版本</span></div><button className="sg-primary sg-start" disabled={!prefs!.draft.trim() || active || !!model.saveError} onClick={() => void run(model.start)}>开始渲染 <span aria-hidden="true">↗</span></button><p className="sg-small">仅发送选中图片和上方提示词。图库封面不上传。</p></>}
            {batch && <section className="sg-queue" aria-label="渲染队列"><div className="sg-panel-title"><h3>本轮结果 {batch.items.filter((i) => i.status === "completed").length}/{batch.items.length}</h3>{active && <button onClick={() => void run(() => model.pause(!batch.paused))}>{batch.paused ? "继续" : "暂停"}</button>}</div>{batch.items.map((item) => { const task = model.tasks.find((t) => t.id === item.taskId); return <div className="sg-queue-item" key={item.id}><strong>{item.sourceName}</strong><span>{simpleTaskLabel(task, item)}</span>{item.error && <p>{item.error}</p>}{task && !["completed", "cancelled", "failed"].includes(task.status) && <><button onClick={() => model.sendToExtension(task, true)}>检查对应网页</button><button onClick={() => void run(() => model.endTracking(task.id))}>结束本地跟踪</button></>}{(item.status === "failed" || item.status === "cancelled") && <button onClick={() => void run(() => model.retry(item.id))}>重新生成</button>}</div>; })}{active && <button onClick={() => void run(model.stop)}>停止后续任务</button>}<details><summary>查看本轮提示词</summary><p className="sg-frozen-prompt">{batch.prompt}</p></details></section>}
          </>}
      </aside>}
    </div>
    {preview && <Preview {...preview} onClose={() => setPreview(null)} />}
  </section>;
}

import { useEffect, useRef, useState } from "react";
import { Rect, Text, Group } from "react-konva";
import { BasicCanvas } from "./BasicCanvas";
import { automationExtensionVersionSupported } from "./canvas-automation";
import { ComparisonOverlay } from "./ComparisonOverlay";
import { useAssetImage } from "./simple-asset-image";
import { bridgeSimpleConcurrencyLimit, exportSelectedImages, getCurrentBridgeToken, selectProjectFolder } from "./bridge-client";

import { batchFinished, pendingSlots, simpleTaskLabel } from "./simple-state";
import { useSimpleProject } from "./use-simple-project";
import { copyPromptText } from "./PromptGallery";



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

  const fileInput = useRef<HTMLInputElement>(null); const folderInput = useRef<HTMLInputElement>(null);


  const [settings, setSettings] = useState(false); const [exporting, setExporting] = useState(false); const [importing, setImporting] = useState(false); const [appending, setAppending] = useState(false);
  const [exportPath, setExportPath] = useState(""); const [preview, setPreview] = useState<{ assetId: string; name: string; versionId?: string } | null>(null); const [comparison, setComparison] = useState<string | null>(null);
  const [editText, setEditText] = useState<string | null>(null); const [showNames, setShowNames] = useState(false);

  const [connection, setConnection] = useState("");
  const generationConnected = automationExtensionVersionSupported(connection, "1.6.0");
  const connectionHint = connection
    ? `当前扩展为 ${connection}，请在 Chrome 扩展管理中重新加载画布扩展，再刷新此页面。需要 1.6.0 或更新版本。`
    : "当前浏览器未连接画布扩展，暂时不能生成图片。请在安装了 GPT Canvas Bridge 扩展的 Chrome 中打开当前项目；Codex 内置浏览器可以浏览和编辑画布。";
  const run = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (e) { model.setNotice((e as Error).message); } };
  const updatePreferences = (change: Partial<NonNullable<typeof prefs>>) => model.update((current) => { Object.assign(current.simple!, change); return current; });
  useEffect(() => {
    const report = () => setConnection(window.document.documentElement.getAttribute("data-gpt-canvas-extension-version") || "");
    report(); window.addEventListener("gpt-canvas-automation-status", report);
    const status = () => { const root = window.document.documentElement; if (root.getAttribute("data-gpt-canvas-automation-status") === "error") model.setNotice(root.getAttribute("data-gpt-canvas-automation-message") || "扩展连接失败"); };
    window.addEventListener("gpt-canvas-automation-status", status);
    return () => { window.removeEventListener("gpt-canvas-automation-status", report); window.removeEventListener("gpt-canvas-automation-status", status); };
  }, []);
  const importFiles = async (files: File[]) => { setImporting(true); try { await model.importFiles(files); } finally { setImporting(false); } };
  const doExport = async () => {
    setExporting(true);
    try { await model.save(); const current = model.ref.current!; const rows = current.canvas.nodes.filter((n) => current.simple!.selectedIds.includes(n.id) && n.type === "image").map((n) => ({ versionId: String(n.payload.imageVersionId), assetId: current.versions.find((v) => v.id === n.payload.imageVersionId)!.assetId, name: String(n.payload.name ?? "图片") }));
      const result = await exportSelectedImages(exportPath, rows); model.setNotice(`已导出 ${result.exported} 张至 ${exportPath}${result.failed ? `；${result.failed} 张失败：${result.records.filter((r) => r.error).map((r) => r.error).join("；")}` : ""}`, { sticky: result.failed > 0 });
    } finally { setExporting(false); }
  };

  if (!doc) return <section className="sg-empty"><h2>{model.loadingError || "正在打开画布…"}</h2>{model.loadingError && <button onClick={onProjects}>返回项目</button>}</section>;
  const selected = doc.canvas.nodes.filter((n) => prefs!.selectedIds.includes(n.id) && n.type === "image");
  const batch = prefs!.batch;
  const active = !batchFinished(batch);
  const openLegacy = async () => { await model.save(); if (active) throw new Error("请先完成或停止当前批次，再进入旧版"); const url = new URL(location.href); url.searchParams.set("legacy", "1"); location.assign(url.href); };
  const copies = prefs!.copiesPerImage ?? 1;
  const concurrencyLimit = bridgeSimpleConcurrencyLimit();
  const plannedTasks = selected.length * copies;
  const pendingSlotMap = pendingSlots(batch?.items ?? []);
  const appendVersion = (sourceVersionId: string) => { setAppending(true); void run(() => model.appendVariant(sourceVersionId)).finally(() => setAppending(false)); };
  const selectedText = doc.workflow?.textCards.find((card) => card.id === editText);
  return <section className="sg-canvas-page" hidden={hidden}>
    <header className="sg-canvas-bar"><button onClick={() => void run(async () => { await model.save(); if (active) throw new Error("请先完成或停止当前批次，再切换项目"); onProjects(); })}>← 项目</button><h1 title={projectName}>{projectName}</h1><span className="sg-save-state">{model.saveError ? "保存需处理" : model.saving ? "保存中…" : "自动保存"}</span>
      <div className="sg-bar-actions"><button onClick={onGallery}>提示词库</button><button onClick={() => { setSettings(true); }}>设置</button></div></header>
    <input hidden ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={(e) => { void run(() => importFiles(Array.from(e.target.files ?? []))); e.target.value = ""; }} />
    <input hidden ref={folderInput} type="file" multiple {...({ webkitdirectory: "" } as Record<string,string>)} onChange={(e) => { void run(() => importFiles(Array.from(e.target.files ?? []))); e.target.value = ""; }} />
    {(model.notice || model.saveError) && <div className={model.saveError ? "sg-message sg-error" : "sg-message"} role={model.saveError ? "alert" : "status"}>{model.saveError || model.notice}{model.saveError && <><button onClick={() => void run(model.save)}>重试保存</button><button onClick={() => void run(model.recover)}>保存本地草稿并载入最新</button></>}</div>}
    <div className={`sg-canvas-layout ${(selected.length || active || settings || selectedText) ? "sg-has-panel" : ""}`}>
      <BasicCanvas doc={doc} update={model.update} undo={model.undo} canUndo={model.canUndo} canRedo={model.canRedo} hidden={hidden} onImport={(files) => void run(() => importFiles(files))} onPreview={(image) => setPreview(image)} onCompare={(versionId) => setComparison(versionId)} onEditText={setEditText}>
            {batch?.items.filter((item) => !["completed", "cancelled"].includes(item.status) && !item.supersededByItemId).map((item) => { const source = doc.canvas.nodes.find((n) => n.payload.imageVersionId === item.sourceVersionId); if (!source) return null; const siblings = doc.canvas.nodes.filter((n) => doc.versions.find((v) => v.id === n.payload.imageVersionId)?.parentVersionId === item.sourceVersionId); const base = siblings.length ? Math.max(...siblings.map((n) => n.y + n.height)) + 48 : source.y; const y = base + (pendingSlotMap.get(item.id) ?? 0) * (source.height + 48); return <Group key={item.id} x={source.x+source.width+96} y={y}><Rect width={source.width} height={source.height} fill="#e4e9e0" stroke="#b0bba8" dash={[7,7]} /><Text y={source.height/2-24} width={source.width} text={`V${item.variantOrdinal ?? 1}`} align="center" fontSize={16} fill="#7a8a72" /><Text y={source.height/2+2} width={source.width} text={simpleTaskLabel(model.tasks.find((t) => t.id === item.taskId), item)} align="center" fontSize={18} fill="#55664f" /></Group>; })}
      </BasicCanvas>
      {(selected.length > 0 || active || settings || selectedText) && <aside className="sg-render-panel" aria-label="渲染面板">
        {settings ? <><div className="sg-panel-title"><h2>画布设置</h2><button onClick={() => setSettings(false)}>关闭</button></div><p className="sg-small">生成参数在主面板提示词下方直接调整。</p><hr /><h3>导入图片</h3><div className="sg-settings-row"><button disabled={importing} onClick={() => fileInput.current?.click()}>{importing ? "导入中…" : "选择图片文件"}</button><button onClick={() => folderInput.current?.click()}>导入文件夹</button></div><hr /><h3>导出所选图片</h3><label>保存文件夹<input value={exportPath} onChange={(e) => setExportPath(e.target.value)} placeholder="选择文件夹或粘贴完整路径" /></label><button onClick={() => void run(async () => { const path = await selectProjectFolder(); if (path) setExportPath(path); })}>选择文件夹</button><button className="sg-primary" disabled={!selected.length || !exportPath || exporting} onClick={() => void run(doExport)}>{exporting ? "导出中…" : `导出 ${selected.length} 张`}</button><hr /><details><summary>连接与兼容</summary><p>浏览器扩展：{connection || "未连接"}</p><button onClick={() => void run(async () => { await copyPromptText(await getCurrentBridgeToken()); model.setNotice("连接令牌已复制，请粘贴到扩展设置", { sticky: false }); })}>复制本地连接令牌</button><button onClick={() => void run(openLegacy)}>打开旧版兼容工作台</button></details></>
          : selectedText ? <><div className="sg-panel-title"><h2>{selectedText.title}</h2><button onClick={() => setEditText(null)}>关闭</button></div><textarea aria-label="历史文字卡内容" className="sg-text-edit" value={selectedText.text} onChange={(e) => model.update((current) => { current.workflow!.textCards.find((c) => c.id === selectedText.id)!.text = e.target.value; return current; }, true)} /><button onClick={() => void run(() => copyPromptText(selectedText.text))}>复制文字</button></>
          : <>{selected.length > 0 ? <p className="sg-context-line">{selected.length === 1 ? `1张 · ${String(selected[0]!.payload.name)}` : `已选${selected.length}张`}{selected.length > 1 && <button className="sg-inline-link" onClick={() => setShowNames((value) => !value)}>{showNames ? "收起" : "查看图片"}</button>}</p> : <p className="sg-context-line">本轮任务</p>}{showNames && selected.length > 1 && <p className="sg-selected-names">{selected.map((n) => String(n.payload.name)).join(" / ")}</p>}{selected.length > 0 && <><label htmlFor="simple-prompt">提示词<button className="sg-inline-link" onClick={onGallery}>从图库复制 ↗</button></label><textarea id="simple-prompt" title="仅发送选中图片和上方提示词。图库封面不上传。" placeholder="在这里粘贴提示词，也可以直接写下你的要求。" maxLength={20000} value={prefs!.draft} onChange={(e) => updatePreferences({ draft: e.target.value })} /></>}{(selected.length > 0 || batch) && <div className="sg-params"><label>同时生成<select aria-label="同时生成" value={prefs!.concurrency} disabled={active} onChange={(e) => updatePreferences({ concurrency: Number(e.target.value) as 1|2|3 })}><option value={1}>1 个任务</option><option value={2}>2 个任务</option>{concurrencyLimit >= 3 && <option value={3}>3 个任务</option>}</select></label><label>每张图生成<select aria-label="每张图生成" value={copies} disabled={active} onChange={(e) => updatePreferences({ copiesPerImage: Number(e.target.value) as 1|2|3 })}><option value={1}>1 个版本</option><option value={2}>2 个版本</option><option value={3}>3 个版本</option></select></label></div>}{active && <p className="sg-small">本轮进行中，完成后可调整。</p>}{selected.length > 0 && <p className="sg-small">{prefs!.draft.length} / 20000 · 已选{selected.length}张 · 共{plannedTasks}个任务</p>}{selected.length > 0 && <button className="sg-primary sg-start" disabled={!generationConnected || !prefs!.draft.trim() || active || !!model.saveError} onClick={() => void run(model.start)}>开始渲染 <span aria-hidden="true">↗</span></button>}{!generationConnected && <p className="sg-small" role="status">{connectionHint}</p>}
            {batch && <section className="sg-queue" aria-label="渲染队列"><div className="sg-panel-title"><h3>本轮结果 {batch.items.filter((i) => i.status === "completed").length}/{batch.items.filter((i) => !i.supersededByItemId).length}</h3>{active && <button onClick={() => void run(() => model.pause(!batch.paused))}>{batch.paused ? "继续" : "暂停"}</button>}</div>{model.lockNotice && <p className="sg-small sg-error" role="status">{model.lockNotice}{model.lockNotice.includes("旧版") && <> <button onClick={() => void run(openLegacy)}>打开旧版兼容工作台</button></>}</p>}{batch.items.map((item) => { const task = model.tasks.find((t) => t.id === item.taskId); return <div className="sg-queue-item" key={item.id}><strong>{item.sourceName} V{item.variantOrdinal ?? 1}</strong><span>{item.supersededByItemId ? "已被新任务替代" : simpleTaskLabel(task, item)}</span>{item.error && !item.supersededByItemId && <p>{item.error}</p>}{!item.supersededByItemId && task && !["completed", "cancelled", "failed"].includes(task.status) && <><button onClick={() => model.sendToExtension(task, true)}>检查对应网页</button><button onClick={() => void run(() => model.endTracking(task.id))}>结束本地跟踪</button></>}{!item.supersededByItemId && (item.status === "queued" || item.status === "running") && <button disabled={appending || !generationConnected} title={generationConnected ? undefined : connectionHint} onClick={() => appendVersion(item.sourceVersionId)}>同样设置再生成</button>}{!item.supersededByItemId && (item.status === "failed" || item.status === "cancelled") && <button disabled={appending || !generationConnected} title={generationConnected ? undefined : connectionHint} onClick={() => void run(() => model.retry(item.id))}>同样设置再生成</button>}</div>; })}{active && <button onClick={() => void run(model.stop)}>停止后续任务</button>}{!generationConnected && batch.items.some((entry) => entry.status === "failed" || entry.status === "cancelled") && <p className="sg-small" role="status">{connectionHint}</p>}<details><summary>查看本轮提示词</summary><p className="sg-frozen-prompt">{batch.prompt}</p></details></section>}
          </>}
      </aside>}
    </div>
    {preview && <Preview {...preview} onClose={() => setPreview(null)} />}
    {comparison && <ComparisonOverlay document={doc} versionId={comparison} onSwitch={(versionId) => setComparison(versionId)} onClose={() => setComparison(null)} />}
  </section>;
}

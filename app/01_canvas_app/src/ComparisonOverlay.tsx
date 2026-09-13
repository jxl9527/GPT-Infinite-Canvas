import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import type { CanvasProjectDocument } from "./project-state";
import { buildComparisonPair, comparisonSiblings, sliderPercent } from "./comparison-model";
import { useAssetImage } from "./simple-asset-image";

function ComparisonImage({ assetId, className }: { assetId: string; className: string }) {
  const display = useAssetImage(assetId, false);
  const original = useAssetImage(assetId, true);
  const image = original ?? display;
  if (!image) return <div className={`${className} sg-compare-loading`} role="status"><p>正在读取图片…</p></div>;
  return <img className={className} src={image.src} alt="" draggable={false} />;
}

function frameSize(width: number, height: number): { width: number; height: number } {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const limit = Math.min(1, 1600 / safeWidth, 1000 / safeHeight);
  return { width: Math.round(safeWidth * limit), height: Math.round(safeHeight * limit) };
}

export function ComparisonOverlay({ document, versionId, onSwitch, onClose }: {
  document: CanvasProjectDocument; versionId: string; onSwitch(versionId: string): void; onClose(): void;
}) {
  const [useRoot, setUseRoot] = useState(false);
  const [percent, setPercent] = useState(50);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [retry, setRetry] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const panning = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const restore = useRef<HTMLElement | null>(null);
  const pair = useMemo(() => buildComparisonPair(document, versionId, useRoot), [document, versionId, useRoot]);
  const fallback = useMemo(() => {
    const version = document.versions.find((entry) => entry.id === versionId);
    const asset = document.assets.find((entry) => entry.id === version?.assetId);
    if (!asset) return null;
    const node = document.canvas.nodes.find((entry) => entry.payload.imageVersionId === versionId);
    return { assetId: asset.id, name: String(node?.payload.name ?? asset.originalName) };
  }, [document, versionId]);
  const siblings = useMemo(() => comparisonSiblings(document, versionId), [document, versionId]);
  const box = pair ? frameSize(pair.baseWidth, pair.baseHeight) : null;
  const fit = useCallback(() => {
    if (!pair || !box || !stage.current) return;
    const width = stage.current.clientWidth - 32; const height = stage.current.clientHeight - 72;
    const next = Math.min(1, width / box.width, height / box.height);
    setScale(Math.max(0.1, next)); setOffset({ x: 0, y: 0 });
  }, [pair, box?.width, box?.height]);

  useEffect(() => {
    restore.current = window.document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const stop = () => { dragging.current = false; panning.current = null; };
    window.addEventListener("pointerup", stop);
    window.addEventListener("blur", stop);
    return () => { window.removeEventListener("pointerup", stop); window.removeEventListener("blur", stop); restore.current?.focus?.(); };
  }, []);
  useEffect(() => { fit(); }, [fit]);
  useEffect(() => {
    const target = stage.current; if (!target) return;
    const observer = new ResizeObserver(() => fit()); observer.observe(target);
    return () => observer.disconnect();
  }, [fit]);
  const moveTo = (clientX: number) => {
    const rect = frame.current?.getBoundingClientRect();
    if (!rect?.width) return;
    setPercent(sliderPercent((clientX - rect.left) / rect.width * 100));
  };
  const keydown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 2;
      setPercent((current) => sliderPercent(current + (event.key === "ArrowRight" ? step : -step)));
      return;
    }
    if (event.key === "Home") { event.preventDefault(); setPercent(0); return; }
    if (event.key === "End") { event.preventDefault(); setPercent(100); return; }
    if (event.key === "Tab") {
      const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button,select") ?? []).filter((element) => !element.hasAttribute("disabled"));
      if (!focusable.length) return;
      const first = focusable[0]!; const last = focusable.at(-1)!;
      if (event.shiftKey && window.document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  };
  const wheel = (event: ReactWheelEvent) => {
    event.preventDefault(); event.stopPropagation();
    setScale((current) => Math.min(8, Math.max(0.1, current * (event.deltaY > 0 ? 0.9 : 1 / 0.9))));
  };
  const pointerDown = (event: ReactPointerEvent) => {
    if (event.button === 1) { panning.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }; event.preventDefault(); return; }
    if (event.button !== 0) return;
    dragging.current = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    moveTo(event.clientX);
  };
  const pointerMove = (event: ReactPointerEvent) => {
    if (panning.current) { setOffset({ x: panning.current.ox + event.clientX - panning.current.x, y: panning.current.oy + event.clientY - panning.current.y }); return; }
    if (dragging.current) moveTo(event.clientX);
  };
  const stopPointer = () => { dragging.current = false; panning.current = null; };
  if (!pair || !box) return <div className="sg-compare" role="dialog" aria-modal="true" aria-label="图片预览" tabIndex={-1} ref={dialog} onKeyDown={keydown}>
    <header className="sg-compare-bar"><span className="sg-compare-name">{fallback?.name ?? "生成结果"}</span><div><small>缺少对比底图</small><button autoFocus onClick={onClose}>关闭预览 ×</button></div></header>
    <div className="sg-compare-stage">{fallback ? <><ComparisonImage key={`fallback-${retry}`} assetId={fallback.assetId} className="sg-compare-solo" /><button onClick={() => setRetry((value) => value + 1)}>重新读取图片</button></> : <p>缺少可显示的图片</p>}</div>
  </div>;
  return <div className="sg-compare" role="dialog" aria-modal="true" aria-label={`对比 ${pair.resultName} 与底图`} tabIndex={-1} ref={dialog} onKeyDown={keydown} onWheel={wheel}>
    <header className="sg-compare-bar">
      <span className="sg-compare-name">{pair.resultName}</span>
      <div>
        {pair.resultOrdinal !== null && <small>生成结果 · V{pair.resultOrdinal}</small>}
        {pair.rootBaseVersionId !== pair.baseVersionId && <button onClick={() => setUseRoot((value) => !value)}>{useRoot ? "对比直接父版本" : "对比最初原图"}</button>}
        {siblings.length > 1 && <select aria-label="切换生成版本" value={versionId} onChange={(event) => onSwitch(event.target.value)}>{siblings.map((id, index) => <option key={id} value={id}>版本 {index + 1}</option>)}</select>}
        <button onClick={fit}>适合窗口</button>
        <button onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }}>100%</button>
        <button onClick={() => setRetry((value) => value + 1)}>重新载入</button>
        <button onClick={onClose}>关闭对比 ×</button>
      </div>
    </header>
    <div className="sg-compare-stage" ref={stage} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={stopPointer} onPointerCancel={stopPointer} onDoubleClick={(event) => event.preventDefault()}>
      <div className="sg-compare-viewport" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}>
        <div className="sg-compare-frame" ref={frame} style={{ width: box.width, height: box.height }}>
          <ComparisonImage key={`base-${retry}`} assetId={pair.baseAssetId} className="sg-compare-layer" />
          <div className="sg-compare-clip" style={{ clipPath: `inset(0 0 0 ${percent}%)` }}>
            <ComparisonImage key={`result-${retry}`} assetId={pair.resultAssetId} className="sg-compare-layer" />
          </div>
          <div className="sg-compare-divider" style={{ left: `${percent}%` }} aria-hidden="true"><span>‹ ›</span></div>
        </div>
      </div>
      <div className="sg-compare-labels"><span>本次底图 · {pair.baseName}</span><span>生成结果 · {pair.resultOrdinal !== null ? `V${pair.resultOrdinal} · ` : ""}{pair.resultName}</span></div>
      {pair.ratioMismatch && <p className="sg-compare-hint">画幅比例不同，仅作完整画面对照</p>}
    </div>
  </div>;
}

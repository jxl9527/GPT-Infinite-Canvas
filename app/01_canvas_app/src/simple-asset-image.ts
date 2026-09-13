import { useState, useEffect } from "react";
import { readCanvasAssetAsObjectUrl, releaseCanvasAssetObjectUrl } from "./bridge-client";
let imageLoads = 0;
const imageQueue: Array<() => void> = [];
async function withImageSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (imageLoads >= 4) await new Promise<void>((resolve) => imageQueue.push(resolve));
  else imageLoads++;
  try { return await operation(); }
  finally { const next = imageQueue.shift(); if (next) next(); else imageLoads--; }
}
export function useAssetImage(assetId: string, original = false) {
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

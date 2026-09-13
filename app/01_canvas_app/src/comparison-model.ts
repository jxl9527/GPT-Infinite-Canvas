import type { CanvasProjectDocument } from "./project-state.js";

export interface ComparisonPair {
  resultVersionId: string;
  resultAssetId: string;
  resultName: string;
  resultOrdinal: number | null;
  resultWidth: number;
  resultHeight: number;
  baseVersionId: string;
  baseAssetId: string;
  baseName: string;
  baseWidth: number;
  baseHeight: number;
  rootBaseVersionId: string;
  isRootBase: boolean;
  ratioMismatch: boolean;
}

function aspect(width: number, height: number): number {
  return height > 0 ? width / height : 1;
}

export function rootBaseVersionId(document: CanvasProjectDocument, versionId: string): string | null {
  let current = document.versions.find((version) => version.id === versionId);
  const seen = new Set<string>();
  while (current?.parentVersionId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = document.versions.find((version) => version.id === current!.parentVersionId);
    if (!parent) break;
    current = parent;
  }
  return current?.id ?? null;
}

export function comparisonSiblings(document: CanvasProjectDocument, versionId: string): string[] {
  const version = document.versions.find((entry) => entry.id === versionId);
  if (!version?.parentVersionId) return [versionId];
  return document.versions.filter((entry) => entry.parentVersionId === version.parentVersionId).map((entry) => entry.id);
}

export function buildComparisonPair(document: CanvasProjectDocument, versionId: string, useRootBase = false): ComparisonPair | null {
  const version = document.versions.find((entry) => entry.id === versionId);
  if (!version?.parentVersionId) return null;
  const rootId = rootBaseVersionId(document, versionId);
  const baseVersionId = useRootBase ? rootId : version.parentVersionId;
  if (!baseVersionId) return null;
  const base = document.versions.find((entry) => entry.id === baseVersionId);
  const resultAsset = document.assets.find((entry) => entry.id === version.assetId);
  const baseAsset = document.assets.find((entry) => entry.id === base?.assetId);
  if (!base || !baseAsset || !resultAsset) return null;
  const node = document.canvas.nodes.find((entry) => entry.payload.imageVersionId === versionId);
  const item = document.simple?.batch?.items.find((entry) => entry.taskId && entry.taskId === version.taskId);
  return {
    resultVersionId: versionId,
    resultAssetId: version.assetId,
    resultName: String(node?.payload.name ?? resultAsset.originalName),
    resultOrdinal: item?.variantOrdinal ?? null,
    resultWidth: resultAsset.original.width,
    resultHeight: resultAsset.original.height,
    baseVersionId,
    baseAssetId: base.assetId,
    baseName: String(baseAsset.originalName),
    baseWidth: baseAsset.original.width,
    baseHeight: baseAsset.original.height,
    rootBaseVersionId: rootId ?? baseVersionId,
    isRootBase: baseVersionId === rootId,
    ratioMismatch: Math.abs(aspect(baseAsset.original.width, baseAsset.original.height) - aspect(resultAsset.original.width, resultAsset.original.height)) > 0.01
  };
}

export function sliderPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

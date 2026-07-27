export const P2_SCHEMA_VERSION = "1.0" as const;

export type ImageAssetKind = "imported" | "generated" | "annotation-export";
export type ImageVersionOrigin = "imported" | "generated" | "annotated";
export type CanvasNodeType = "image" | "text" | "arrow" | "freehand" | "rectangle";

export interface ImageFileRecord {
  relativePath: string;
  mime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  bytes: number;
  sha256: string;
}

export interface ImageAsset {
  id: `asset_${string}`;
  kind: ImageAssetKind;
  original: ImageFileRecord;
  display?: ImageFileRecord;
  thumbnail?: ImageFileRecord;
  createdAt: string;
}

export interface ImageVersion {
  id: `version_${string}`;
  assetId: `asset_${string}`;
  origin: ImageVersionOrigin;
  parentVersionId: `version_${string}` | null;
  taskId: `task_${string}` | null;
  label?: string;
  createdAt: string;
}

export interface CanvasNode {
  id: `node_${string}`;
  type: CanvasNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  zIndex: number;
  locked: boolean;
  visible: boolean;
  payload: Record<string, unknown>;
}

export interface CanvasViewport {
  x: number;
  y: number;
  scale: number;
}

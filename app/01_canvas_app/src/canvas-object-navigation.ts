export type CanvasObjectKind = "image" | "text-card" | "annotation";

export interface CanvasObjectSelection {
  kind: CanvasObjectKind;
  id: string;
}

export interface CanvasObjectOption extends CanvasObjectSelection {
  label: string;
}

export interface CanvasObjectGroup {
  label: string;
  options: readonly CanvasObjectOption[];
}

const CANVAS_OBJECT_KINDS = new Set<CanvasObjectKind>(["image", "text-card", "annotation"]);

export function encodeCanvasObjectValue(kind: CanvasObjectKind, id: string): string {
  return `${kind}:${id}`;
}

export function decodeCanvasObjectValue(value: string): CanvasObjectSelection | null {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  const kind = value.slice(0, separator) as CanvasObjectKind;
  const id = value.slice(separator + 1);
  if (!CANVAS_OBJECT_KINDS.has(kind) || /[\r\n]/.test(id)) return null;
  return { kind, id };
}

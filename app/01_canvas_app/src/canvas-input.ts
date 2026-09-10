export function isMiddleMouseButton(button: number): boolean {
  return button === 1;
}

export type CanvasKeyboardAction =
  | "exit-annotation"
  | "delete-annotation"
  | "delete-image"
  | "tool-text"
  | "tool-arrow"
  | "tool-freehand"
  | "tool-rectangle"
  | "tool-marquee";

export function canvasKeyboardAction(
  key: string,
  options: {
    editableTarget: boolean;
    hasSelectedAnnotation: boolean;
    hasSelectedImage: boolean;
    modifierPressed: boolean;
  }
): CanvasKeyboardAction | null {
  if (key === "Escape") return "exit-annotation";
  if (options.editableTarget || options.modifierPressed) return null;
  if ((key === "Delete" || key === "Backspace") && options.hasSelectedAnnotation) {
    return "delete-annotation";
  }
  if ((key === "Delete" || key === "Backspace") && options.hasSelectedImage) {
    return "delete-image";
  }
  const normalized = key.toLowerCase();
  if (normalized === "t") return "tool-text";
  if (normalized === "a") return "tool-arrow";
  if (normalized === "p") return "tool-freehand";
  if (normalized === "r") return "tool-rectangle";
  if (normalized === "m") return "tool-marquee";
  return null;
}

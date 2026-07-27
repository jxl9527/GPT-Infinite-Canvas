export type AnnotationType = "text" | "arrow" | "freehand" | "rectangle";

interface AnnotationBase {
  id: `annotation_${string}`;
  type: AnnotationType;
  x: number;
  y: number;
  color: string;
  comment?: string;
}

export interface TextAnnotation extends AnnotationBase {
  type: "text";
  text: string;
  width: number;
  fontSize: number;
}

export interface RectangleAnnotation extends AnnotationBase {
  type: "rectangle";
  width: number;
  height: number;
}

export interface ArrowAnnotation extends AnnotationBase {
  type: "arrow";
  points: number[];
}

export interface FreehandAnnotation extends AnnotationBase {
  type: "freehand";
  points: number[];
}

export type AnnotationState = TextAnnotation | RectangleAnnotation | ArrowAnnotation | FreehandAnnotation;

export interface AnnotationBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function annotationBounds(annotation: AnnotationState): AnnotationBounds {
  if (annotation.type === "rectangle") {
    return {
      x: annotation.x + Math.min(0, annotation.width),
      y: annotation.y + Math.min(0, annotation.height),
      width: Math.abs(annotation.width),
      height: Math.abs(annotation.height)
    };
  }
  if (annotation.type === "text") {
    return {
      x: annotation.x,
      y: annotation.y,
      width: annotation.width,
      height: annotation.fontSize * 2
    };
  }
  const xs = annotation.points.filter((_, index) => index % 2 === 0);
  const ys = annotation.points.filter((_, index) => index % 2 === 1);
  const minimumX = Math.min(0, ...xs);
  const maximumX = Math.max(0, ...xs);
  const minimumY = Math.min(0, ...ys);
  const maximumY = Math.max(0, ...ys);
  return {
    x: annotation.x + minimumX,
    y: annotation.y + minimumY,
    width: maximumX - minimumX,
    height: maximumY - minimumY
  };
}

export function annotationIntersectsRect(
  annotation: AnnotationState,
  rect: AnnotationBounds
): boolean {
  const bounds = annotationBounds(annotation);
  return (
    bounds.x <= rect.x + rect.width
    && bounds.x + Math.max(1, bounds.width) >= rect.x
    && bounds.y <= rect.y + rect.height
    && bounds.y + Math.max(1, bounds.height) >= rect.y
  );
}

export function normalizeRectangle(annotation: RectangleAnnotation): RectangleAnnotation {
  return {
    ...annotation,
    x: annotation.x + Math.min(0, annotation.width),
    y: annotation.y + Math.min(0, annotation.height),
    width: Math.abs(annotation.width),
    height: Math.abs(annotation.height)
  };
}

export function scaleAnnotation(annotation: AnnotationState, scaleX: number, scaleY: number): AnnotationState {
  if (annotation.type === "rectangle") {
    return {
      ...annotation,
      width: Math.max(8, Math.round(annotation.width * Math.abs(scaleX))),
      height: Math.max(8, Math.round(annotation.height * Math.abs(scaleY)))
    };
  }
  if (annotation.type === "text") {
    return {
      ...annotation,
      width: Math.max(80, Math.round(annotation.width * Math.abs(scaleX))),
      fontSize: Math.max(10, Math.round(annotation.fontSize * Math.abs(scaleY)))
    };
  }
  return {
    ...annotation,
    points: annotation.points.map((value, index) => value * Math.abs(index % 2 === 0 ? scaleX : scaleY))
  };
}

export function annotationTypeLabel(type: AnnotationType): string {
  return {
    text: "文字批注",
    arrow: "箭头批注",
    freehand: "画笔批注",
    rectangle: "矩形框选"
  }[type];
}

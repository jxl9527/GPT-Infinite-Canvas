import { coverCrop, type ImageNodeState } from "./canvas-layout";
import type { AnnotationState } from "./annotation-model";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法读取选中图片，批注图未保存"));
    image.src = src;
  });
}

function drawArrow(
  context: CanvasRenderingContext2D,
  points: number[],
  offset: { x: number; y: number },
  scale: { x: number; y: number }
) {
  if (points.length < 4) return;
  const x1 = (offset.x + (points[0] ?? 0)) * scale.x;
  const y1 = (offset.y + (points[1] ?? 0)) * scale.y;
  const x2 = (offset.x + (points.at(-2) ?? 0)) * scale.x;
  const y2 = (offset.y + (points.at(-1) ?? 0)) * scale.y;
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.stroke();
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(14, context.lineWidth * 5);
  context.beginPath();
  context.moveTo(x2, y2);
  context.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
  context.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
  context.closePath();
  context.fill();
}

function drawFreehand(
  context: CanvasRenderingContext2D,
  points: number[],
  offset: { x: number; y: number },
  scale: { x: number; y: number }
) {
  if (points.length < 4) return;
  context.beginPath();
  context.moveTo((offset.x + (points[0] ?? 0)) * scale.x, (offset.y + (points[1] ?? 0)) * scale.y);
  for (let index = 2; index < points.length; index += 2) {
    context.lineTo(
      (offset.x + (points[index] ?? 0)) * scale.x,
      (offset.y + (points[index + 1] ?? 0)) * scale.y
    );
  }
  context.stroke();
}

function drawComment(
  context: CanvasRenderingContext2D,
  text: string,
  anchor: { x: number; y: number },
  canvasSize: { width: number; height: number },
  color: string
) {
  const content = text.trim();
  if (!content) return;
  const fontSize = Math.max(22, canvasSize.width / 58);
  const maximumWidth = Math.min(canvasSize.width * 0.56, fontSize * 22);
  context.font = `600 ${fontSize}px "Microsoft YaHei UI", sans-serif`;
  context.textBaseline = "top";
  const lines: string[] = [];
  let current = "";
  for (const character of content) {
    const candidate = `${current}${character}`;
    if (current && context.measureText(candidate).width > maximumWidth) {
      lines.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  const visibleLines = lines.slice(0, 4);
  const lineHeight = fontSize * 1.45;
  const padding = fontSize * 0.55;
  const textWidth = Math.max(...visibleLines.map((line) => context.measureText(line).width));
  const boxWidth = Math.min(canvasSize.width - padding * 2, textWidth + padding * 2);
  const boxHeight = visibleLines.length * lineHeight + padding * 1.3;
  const x = Math.max(padding, Math.min(anchor.x, canvasSize.width - boxWidth - padding));
  const y = Math.max(padding, Math.min(anchor.y + fontSize * 0.35, canvasSize.height - boxHeight - padding));
  context.fillStyle = "rgba(248, 244, 237, 0.94)";
  context.fillRect(x, y, boxWidth, boxHeight);
  context.strokeStyle = color;
  context.lineWidth = Math.max(3, fontSize * 0.12);
  context.strokeRect(x, y, boxWidth, boxHeight);
  context.fillStyle = color;
  visibleLines.forEach((line, index) => {
    context.fillText(line, x + padding, y + padding * 0.65 + index * lineHeight, maximumWidth);
  });
}

export async function renderAnnotationExport(
  node: ImageNodeState,
  annotations: readonly AnnotationState[]
): Promise<string> {
  const image = await loadImage(node.src);
  const maximum = 4096;
  const width = Math.max(1, Math.min(maximum, node.sourceWidth));
  const height = node.outputRatio === "free"
    ? Math.max(1, Math.round(node.sourceHeight * (width / node.sourceWidth)))
    : Math.max(1, Math.round(width / (node.width / node.height)));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法创建批注导出画布");

  const crop = coverCrop(
    { width: node.sourceWidth, height: node.sourceHeight },
    { width: node.width, height: node.height }
  );
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
  context.save();
  context.beginPath();
  context.rect(0, 0, width, height);
  context.clip();
  const scale = { x: width / node.width, y: height / node.height };
  context.lineCap = "round";
  context.lineJoin = "round";

  for (const annotation of annotations) {
    const offset = { x: annotation.x - node.x, y: annotation.y - node.y };
    context.strokeStyle = annotation.color;
    context.fillStyle = annotation.color;
    context.lineWidth = Math.max(4, width / 420);
    if (annotation.type === "rectangle") {
      context.strokeRect(offset.x * scale.x, offset.y * scale.y, annotation.width * scale.x, annotation.height * scale.y);
    } else if (annotation.type === "arrow") {
      drawArrow(context, annotation.points, offset, scale);
    } else if (annotation.type === "freehand") {
      drawFreehand(context, annotation.points, offset, scale);
    } else {
      const fontSize = Math.max(18, annotation.fontSize * Math.min(scale.x, scale.y));
      context.font = `600 ${fontSize}px "Microsoft YaHei UI", sans-serif`;
      context.textBaseline = "top";
      const x = offset.x * scale.x;
      const y = offset.y * scale.y;
      const textWidth = Math.min(annotation.width * scale.x, width - x);
      const metrics = context.measureText(annotation.text);
      const backgroundWidth = Math.min(textWidth, metrics.width + fontSize);
      context.fillStyle = "rgba(244, 237, 227, 0.9)";
      context.fillRect(x - fontSize * 0.25, y - fontSize * 0.2, backgroundWidth + fontSize * 0.5, fontSize * 1.5);
      context.fillStyle = annotation.color;
      context.fillText(annotation.text, x, y, Math.max(1, textWidth));
    }
    if (annotation.type !== "text" && annotation.comment?.trim()) {
      const end = annotation.type === "rectangle"
        ? {
          x: (offset.x + annotation.width) * scale.x,
          y: (offset.y + annotation.height) * scale.y
        }
        : {
          x: (offset.x + (annotation.points.at(-2) ?? 0)) * scale.x,
          y: (offset.y + (annotation.points.at(-1) ?? 0)) * scale.y
        };
      drawComment(context, annotation.comment, end, { width, height }, annotation.color);
    }
  }
  context.restore();
  return canvas.toDataURL("image/png");
}

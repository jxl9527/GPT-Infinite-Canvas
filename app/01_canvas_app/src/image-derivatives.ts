function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法解码图片以创建显示图"));
    image.src = src;
  });
}

async function resizeImage(
  src: string,
  maximumWidth: number,
  maximumHeight: number,
  quality: number
): Promise<string> {
  const image = await loadImage(src);
  const scale = Math.min(1, maximumWidth / image.naturalWidth, maximumHeight / image.naturalHeight);
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("浏览器无法创建图片显示层");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
  const webp = canvas.toDataURL("image/webp", quality);
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
}

export async function createImageDerivatives(src: string): Promise<{
  displayDataUrl: string;
  thumbnailDataUrl: string;
}> {
  const [displayDataUrl, thumbnailDataUrl] = await Promise.all([
    resizeImage(src, 1280, 1280, 0.86),
    resizeImage(src, 360, 360, 0.78)
  ]);
  return { displayDataUrl, thumbnailDataUrl };
}

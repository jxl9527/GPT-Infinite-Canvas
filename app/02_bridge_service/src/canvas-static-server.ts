import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

function sendText(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(`${message}\n`);
}

export function createCanvasStaticServer(distRootInput: string) {
  const distRoot = resolve(distRootInput);
  return createServer(async (request, response) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendText(response, 405, "Method Not Allowed");
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      let pathname: string;
      try { pathname = decodeURIComponent(url.pathname); }
      catch { sendText(response, 400, "Bad Request"); return; }
      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const absolute = resolve(distRoot, relative);
      if (!(absolute === distRoot || absolute.startsWith(`${distRoot}${sep}`))) {
        sendText(response, 404, "Not Found");
        return;
      }
      const info = await stat(absolute).catch(() => null);
      if (!info?.isFile()) {
        sendText(response, 404, "Not Found");
        return;
      }
      const extension = extname(absolute).toLowerCase();
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[extension] ?? "application/octet-stream",
        "content-length": info.size,
        "cache-control": extension === ".html" ? "no-store" : "public, max-age=31536000, immutable",
        "content-security-policy": "default-src 'self'; img-src 'self' data: blob:; connect-src http://127.0.0.1:3220; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY"
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(absolute).pipe(response);
    } catch {
      if (!response.headersSent) sendText(response, 500, "Internal Server Error");
      else response.destroy();
    }
  });
}

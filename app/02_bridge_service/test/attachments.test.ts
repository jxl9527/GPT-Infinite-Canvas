import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProtocolError, type CreateTaskInput } from "@gpt-canvas/shared";
import { readTaskAttachment, resolveTaskAttachments } from "../src/attachments.js";
import { TaskStore } from "../src/task-store.js";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL3SAAAAABJRU5ErkJggg==", "base64");

test("附件只能来自 assets 或 annotations，且创建后发生变化会被拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "gpt-canvas-p1-attachment-"));
  await mkdir(join(root, "assets", "originals"), { recursive: true });
  await mkdir(join(root, "annotations"), { recursive: true });
  await writeFile(join(root, "assets", "originals", "input.png"), pixel);
  await writeFile(join(root, "annotations", "marked.png"), pixel);
  await writeFile(join(root, "outside.png"), pixel);
  await assert.rejects(
    () => resolveTaskAttachments(root, [{ role: "edit-target", name: "outside.png", relativePath: "outside.png" }]),
    (error) => error instanceof ProtocolError && error.code === "INVALID_ATTACHMENT"
  );

  const input: CreateTaskInput = {
    taskType: "edit", target: { chatMode: "new" }, prompt: "验证附件不可变",
    attachments: [{ role: "edit-target", name: "input.png", relativePath: "assets/originals/input.png" }]
  };
  const attachments = await resolveTaskAttachments(root, input.attachments);
  const annotationAttachments = await resolveTaskAttachments(root, [{
    role: "annotation-map",
    name: "批注图.png",
    relativePath: "annotations/marked.png"
  }]);
  assert.equal(annotationAttachments[0]?.role, "annotation-map");
  assert.equal(annotationAttachments[0]?.sha256, attachments[0]?.sha256);
  const store = new TaskStore(root); await store.init(); const task = await store.create(input, attachments);
  await writeFile(join(root, "assets", "originals", "input.png"), Buffer.concat([pixel, Buffer.from([0])]));
  await assert.rejects(
    () => readTaskAttachment(root, task, attachments[0]?.id ?? ""),
    (error) => error instanceof ProtocolError && error.code === "INVALID_ATTACHMENT"
  );
});

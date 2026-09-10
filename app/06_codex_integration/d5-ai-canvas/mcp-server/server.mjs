import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { bridgeBaseUrl, bridgeRequest } from "./bridge-client.mjs";
import { readAuthorizedGeneratedImage } from "./image-file.mjs";

const server = new McpServer(
  { name: "d5-ai-canvas", version: "0.5.3" },
  { instructions: "Use only these domain tools for D5 AI Canvas. Keep source folders read-only, require confirmed authorization for writes, preserve rejected candidates, retry scene-optimization structure risks within the authorized per-item budget, stop on failed final-glass validation, and never automatically select a final image." }
);

function result(summary, structuredContent) {
  return { content: [{ type: "text", text: summary }], structuredContent };
}

function failure(error) {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    structuredContent: { ok: false, error: { code: error?.code || "MCP_BRIDGE_ERROR", message: error instanceof Error ? error.message : String(error) } }
  };
}

function register(name, config, handler) {
  server.registerTool(name, config, async (input = {}) => {
    try { return await handler(input); }
    catch (error) { return failure(error); }
  });
}

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

register("d5_get_capabilities", {
  title: "Get D5 AI Canvas Capabilities",
  description: "Check the local bridge, active project, supported stages, and restricted capabilities.",
  inputSchema: {}, annotations: readAnnotations
}, async () => {
  const [health, capabilities] = await Promise.all([
    bridgeRequest("/health"),
    bridgeRequest("/api/v1/canvas/codex-capabilities")
  ]);
  return result(`D5 AI Canvas bridge is available at ${bridgeBaseUrl()}.`, { ok: true, health, ...capabilities });
});

register("d5_scan_project_folder", {
  title: "Scan D5 Project Folder",
  description: "Read-only scan of one explicit absolute folder and create an import manifest without changing source files.",
  inputSchema: { sourceRoot: z.string().trim().min(3), includeSubfolders: z.boolean().optional() },
  annotations: readAnnotations
}, async (input) => {
  const payload = await bridgeRequest("/api/v1/canvas/folder-manifests/scan", { body: input });
  return result(`Scanned ${payload.manifest.fileCount} image files; ${payload.manifest.importableCount} are importable.`, payload);
});

register("d5_import_manifest", {
  title: "Import Confirmed D5 Manifest",
  description: "Copy only confirmed manifest images into the active canvas project; never alters source files.",
  inputSchema: { manifestId: z.string().startsWith("manifest_"), selectedRelativePaths: z.array(z.string().trim()).min(1).max(500), confirmed: z.literal(true) },
  annotations: writeAnnotations
}, async (input) => {
  const payload = await bridgeRequest(`/api/v1/canvas/folder-manifests/${encodeURIComponent(input.manifestId)}/import`, {
    body: { selectedRelativePaths: input.selectedRelativePaths }
  });
  return result(`Imported manifest ${input.manifestId}; source folder remains read-only.`, payload);
});

register("d5_get_workflow_state", {
  title: "Get D5 Canvas Workflow State",
  description: "Read the active canvas project, stages, viewpoints, versions, text cards, and current dual-channel batch state.",
  inputSchema: {}, annotations: readAnnotations
}, async () => {
  const payload = await bridgeRequest("/api/v1/canvas/project");
  return result(payload.project ? `Loaded canvas revision ${payload.project.revision}.` : "No canvas project has been saved yet.", payload);
});

register("d5_create_run", {
  title: "Create Authorized Codex Run",
  description: "Create one bounded B-mode run from a user-confirmed authorization form.",
  inputSchema: {
    authorizationId: z.string().regex(/^authorization_[0-9a-z_-]{8,120}$/i),
    manifestId: z.string().startsWith("manifest_").optional(),
    sourceFolder: z.string().trim().nullable(),
    stage: z.enum(["preflight", "scene-optimization", "final-glass"]),
    action: z.enum(["analyze", "prompt", "generate"]),
    sourceVersionIds: z.array(z.string().startsWith("version_")).min(1).max(200),
    styleReferenceVersionId: z.string().startsWith("version_").nullable().optional(),
    prompt: z.string().max(12000).optional(),
    maximumGenerations: z.number().int().min(0).max(200),
    allowManualFallback: z.boolean(),
    stopOnStructureRisk: z.boolean(),
    approvedAt: z.string().datetime().optional(),
    codexThreadId: z.string().max(500).nullable().optional(),
    confirmed: z.literal(true)
  }, annotations: writeAnnotations
}, async (input) => {
  const payload = await bridgeRequest("/api/v1/canvas/codex-runs", { body: input });
  return result(`Created Codex run ${payload.run.id} for ${payload.run.items.length} items.`, payload);
});

register("d5_register_text_card", {
  title: "Register D5 Review or Prompt Card",
  description: "Register an authorized review/prompt card left of its source image and advance only that run item.",
  inputSchema: {
    runId: z.string().startsWith("batch_"),
    authorizationId: z.string().startsWith("authorization_"),
    sourceVersionId: z.string().startsWith("version_"),
    kind: z.enum(["review", "prompt"]),
    title: z.string().max(120),
    text: z.string().trim().min(1).max(20000),
    workflowLabel: z.string().max(120).optional(),
    idempotencyKey: z.string().trim().min(8).max(500)
  }, annotations: writeAnnotations
}, async (input) => {
  const { runId, ...body } = input;
  const payload = await bridgeRequest(`/api/v1/canvas/codex-runs/${encodeURIComponent(runId)}/text-cards`, { body });
  return result(`Registered ${input.kind} card ${payload.card.id} left of ${input.sourceVersionId}.`, payload);
});

register("d5_get_run_item_inputs", {
  title: "Get Authorized D5 Run Item Inputs",
  description: "Resolve project-copy image paths and roles for one authorized run item; source files remain untouched.",
  inputSchema: { runId: z.string().startsWith("batch_"), itemId: z.string().startsWith("batch_item_") },
  annotations: readAnnotations
}, async (input) => {
  const payload = await bridgeRequest(`/api/v1/canvas/codex-runs/${encodeURIComponent(input.runId)}/items/${encodeURIComponent(input.itemId)}/inputs`);
  return result(`Loaded ${payload.item.inputs.length} project-copy inputs for ${input.itemId}.`, payload);
});

register("d5_mark_generation_submitted", {
  title: "Mark D5 Generation Submitted",
  description: "Claim the next strictly serial item and record the generation-submitted checkpoint before calling image generation.",
  inputSchema: {
    runId: z.string().startsWith("batch_"),
    itemId: z.string().startsWith("batch_item_"),
    authorizationId: z.string().startsWith("authorization_"),
    leaseOwner: z.string().max(500).optional(),
    confirmed: z.literal(true)
  }, annotations: writeAnnotations
}, async (input) => {
  const { runId, itemId, ...body } = input;
  const payload = await bridgeRequest(`/api/v1/canvas/codex-runs/${encodeURIComponent(runId)}/items/${encodeURIComponent(itemId)}/generation-submitted`, { body });
  return result(`Recorded generation-submitted for ${itemId}; do not resubmit this item on handoff.`, payload);
});

register("d5_register_generated_result", {
  title: "Register D5 Generated Result",
  description: "Copy one Codex-generated image from an allowed output root, link it to its source version, arrange it right of the source, and validate dimensions/ratio.",
  inputSchema: {
    runId: z.string().startsWith("batch_"),
    itemId: z.string().startsWith("batch_item_"),
    authorizationId: z.string().startsWith("authorization_"),
    leaseOwner: z.string().trim().min(1).max(500),
    generatedImagePath: z.string().trim().min(3),
    resultName: z.string().max(180).optional(),
    structureRisk: z.enum(["none", "suspected", "confirmed"]),
    validationNotes: z.string().max(1000).optional(),
    confirmed: z.literal(true)
  }, annotations: writeAnnotations
}, async (input) => {
  const file = await readAuthorizedGeneratedImage(input.generatedImagePath);
  const imported = await bridgeRequest("/api/v1/canvas/generated-assets", {
    body: { name: input.resultName?.trim() || file.name, dataUrl: file.dataUrl }
  });
  const payload = await bridgeRequest(`/api/v1/canvas/codex-runs/${encodeURIComponent(input.runId)}/items/${encodeURIComponent(input.itemId)}/generated-results`, {
    body: {
      authorizationId: input.authorizationId,
      assetId: imported.asset.id,
      structureRisk: input.structureRisk,
      validationNotes: input.validationNotes,
      confirmed: true
    }
  });
  const validationSummary = payload.validation.passed
    ? "passed"
    : payload.validation.retryScheduled
      ? `failed; retry ${payload.validation.itemAttemptsUsed + 1}/${payload.validation.itemGenerationBudget} scheduled`
      : "failed; item budget exhausted or strict-stage pause required";
  return result(`Registered generated result ${payload.versionId}; validation ${validationSummary}.`, { ...payload, sourceFile: { path: file.path, mime: file.mime, bytes: file.bytes } });
});

register("d5_handoff_run_items", {
  title: "Handoff D5 Run Items Between A and B",
  description: "Switch only unfinished items of a paused run between manual and Codex runners; refuses items awaiting generated results.",
  inputSchema: {
    runId: z.string().startsWith("batch_"),
    targetRunner: z.enum(["manual", "codex"]),
    reason: z.string().trim().min(1).max(500),
    confirmed: z.literal(true)
  }, annotations: writeAnnotations
}, async (input) => {
  const { runId, ...body } = input;
  const payload = await bridgeRequest(`/api/v1/canvas/codex-runs/${encodeURIComponent(runId)}/handoff`, { body });
  return result(`Run ${runId} handed to ${input.targetRunner}; completed items were preserved.`, payload);
});

for (const action of ["pause", "resume"]) {
  register(`d5_${action}_run`, {
    title: `${action === "pause" ? "Pause" : "Resume"} D5 Codex Run`,
    description: `${action === "pause" ? "Pause" : "Resume"} one B-mode run at a safe checkpoint without resubmitting completed items.`,
    inputSchema: { runId: z.string().startsWith("batch_"), reason: z.string().max(500).optional(), leaseOwner: z.string().max(500).optional() },
    annotations: writeAnnotations
  }, async (input) => {
    const { runId, ...body } = input;
    const payload = await bridgeRequest(`/api/v1/canvas/codex-runs/${encodeURIComponent(runId)}/${action}`, { body });
    return result(`${action === "pause" ? "Paused" : "Resumed"} Codex run ${runId}.`, payload);
  });
}

await server.connect(new StdioServerTransport());

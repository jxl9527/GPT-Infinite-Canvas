---
name: run-d5-canvas-workflow
description: Safely operate the local D5 AI Canvas dual-channel architectural-image workflow through its MCP domain tools. Use when the user asks Codex to scan a project folder, import D5/SU/style-reference images, run preflight analysis, prepare scene-optimization prompts, generate authorized reference effects, deepen glass on final D5 full frames, pause or resume a batch, or arrange review cards and results on the canvas.
---

# Run D5 Canvas Workflow

Operate only through the `d5_*` MCP domain tools. Never edit the canvas project JSON, source image folder, or bridge token directly.

## Start safely

1. Call `d5_get_capabilities` and `d5_get_workflow_state`.
2. If the user chooses the current canvas, use only the source version IDs already present in the confirmed canvas scope; do not require or scan a project folder. Current explicit canvas selection has priority over registered D5 viewpoints.
3. Call `d5_scan_project_folder` only when the user explicitly chooses the folder source and supplies an absolute folder.
4. For folder source, present the manifest summary and ambiguous roles before import. Do not scan parent, sibling, disk-root, hidden, or symlinked paths. Import only confirmed entries and treat them as read-only project copies.
5. Before any write batch, require a confirmed authorization ID, stage, item list, generation ceiling, fallback choice, and structure-risk stop rule.

Read [stage-contracts.md](references/stage-contracts.md) before running a stage. Read [recovery.md](references/recovery.md) when a run is interrupted, paused, partially failed, or handed between the browser-manual and Codex-automatic channels.

## Execute one stage at a time

- Preflight: analyze each D5 locked view with its matching SU reference when present. Register a concise review card to the left of the source. Do not generate an image.
- Scene optimization in the Codex-automatic channel is one continuous authorized action: generate and register the prompt card, read the run-item inputs again and use the returned approved prompt, mark `generation-submitted`, call Codex image generation with the project-copy paths, then register the generated file. Do not ask the user to choose prompt or generation a second time after the run authorization is confirmed. Treat the source as a pixel-aligned edit base, not a design reference: explicitly lock silhouette, floor count, entrance void, column grid, balconies, openings, facade subdivisions, road junctions, crossings, curbs, camera, crop, and aspect ratio. If preserving a region would require redrawing it, leave that region unchanged. The browser-manual channel keeps prompt and image generation as separate manual actions.
- Final glass: accept only a final D5 complete frame. Deepen glass without masks and without changing any non-glass region. Registering the result must pass exact pixel-dimension validation.

Run items serially. Re-read workflow state after each write. Use the item idempotency key for retries. Create one stable, non-empty `leaseOwner` for the active Codex runner, pass it to `d5_mark_generation_submitted`, and pass the exact same value to `d5_register_generated_result`; never borrow or replace another runner's lease. In scene optimization, a rejected structural-risk candidate may return the same item to `prompt-approved`; generate the next candidate for that item while its allocated per-item budget remains. Preserve every rejected candidate and its validation note. When that item's budget is exhausted, leave it failed and continue with the next queued viewpoint. Stop immediately on source mutation, prompt mutation, authorization mismatch, lease conflict, missing result, total capacity exhaustion, or any failed final-glass validation.

## Preserve architectural truth

Treat the structural-base image as the sole source of geometry. Preserve building form, count, proportion, orientation, axonometric/camera view, roads, site boundary, explosion levels, openings, and spatial relationships. A style reference controls only color, material, light, atmosphere, linework, labels, and environmental expression.

Never automatically select the final adopted version. Leave candidates on canvas for human comparison and selection.

## Handoff and reporting

Pause at a safe checkpoint before handing work to the browser-manual channel. Never resubmit items at `generation-submitted` or later without first reading their current status. Report completed, failed, paused, and remaining counts; the latest checkpoint; remaining authorized generations; and the project log location.

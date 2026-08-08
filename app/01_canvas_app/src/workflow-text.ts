import { MAX_VIEWPOINT_CONCLUSION_LENGTH } from "@gpt-canvas/shared";

export function workflowConclusionFromText(text: string): string {
  if (text.length <= MAX_VIEWPOINT_CONCLUSION_LENGTH) return text;
  return `${text.slice(0, MAX_VIEWPOINT_CONCLUSION_LENGTH - 1).trimEnd()}…`;
}

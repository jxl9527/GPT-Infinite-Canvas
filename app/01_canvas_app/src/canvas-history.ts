import type { AnnotationState } from "./annotation-model.js";
import type { ImageNodeState } from "./canvas-layout.js";
import type { CanvasTextCard } from "./text-card.js";

export interface CanvasHistorySnapshot {
  nodes: ImageNodeState[];
  annotations: AnnotationState[];
  textCards: CanvasTextCard[];
  structureBaseId: string | null;
  styleReferenceId: string | null;
  taskInstruction: string;
}

export interface CanvasHistoryState {
  entries: CanvasHistorySnapshot[];
  cursor: number;
}

function snapshotKey(snapshot: CanvasHistorySnapshot): string {
  return JSON.stringify({
    ...snapshot,
    nodes: snapshot.nodes.map(({ src: _src, ...node }) => node)
  });
}

function cloneSnapshot(snapshot: CanvasHistorySnapshot): CanvasHistorySnapshot {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => ({ ...node })),
    annotations: snapshot.annotations.map((annotation) => structuredClone(annotation)),
    textCards: snapshot.textCards.map((card) => ({ ...card }))
  };
}

export function createCanvasHistory(snapshot: CanvasHistorySnapshot): CanvasHistoryState {
  return { entries: [cloneSnapshot(snapshot)], cursor: 0 };
}

export function pushCanvasHistory(
  state: CanvasHistoryState,
  snapshot: CanvasHistorySnapshot,
  maximumEntries = 50
): CanvasHistoryState {
  const current = state.entries[state.cursor];
  if (current && snapshotKey(current) === snapshotKey(snapshot)) return state;
  const entries = [...state.entries.slice(0, state.cursor + 1), cloneSnapshot(snapshot)];
  const bounded = entries.slice(Math.max(0, entries.length - Math.max(2, maximumEntries)));
  return { entries: bounded, cursor: bounded.length - 1 };
}

export function moveCanvasHistory(
  state: CanvasHistoryState,
  direction: -1 | 1
): { state: CanvasHistoryState; snapshot: CanvasHistorySnapshot | null } {
  const cursor = state.cursor + direction;
  if (cursor < 0 || cursor >= state.entries.length) return { state, snapshot: null };
  return {
    state: { ...state, cursor },
    snapshot: cloneSnapshot(state.entries[cursor]!)
  };
}

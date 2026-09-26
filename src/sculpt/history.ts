/**
 * Undo / redo of sculpt strokes: each entry holds the sparse per-mesh
 * deltas of one stroke (or reset). Capped by entry count and by memory; the
 * oldest entries go first (their changes simply stay applied).
 */
import { deltaBytes, type MeshDelta } from './sculptMesh';

export interface StrokeRecord {
  deltas: MeshDelta[];
  /** Applied-stroke counter before / after this entry (so undo / redo restore it exactly). */
  countBefore: number;
  countAfter: number;
  bytes: number;
}

export const DEFAULT_MAX_STROKES = 64;
export const DEFAULT_MAX_HISTORY_BYTES = 192 * 1024 * 1024;

export class SculptHistory {
  private undoStack: StrokeRecord[] = [];
  private redoStack: StrokeRecord[] = [];
  private bytes = 0;

  constructor(
    readonly maxStrokes = DEFAULT_MAX_STROKES,
    readonly maxBytes = DEFAULT_MAX_HISTORY_BYTES,
  ) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get size(): number {
    return this.undoStack.length;
  }

  get memoryBytes(): number {
    return this.bytes;
  }

  static record(deltas: MeshDelta[], countBefore: number, countAfter: number): StrokeRecord {
    return { deltas, countBefore, countAfter, bytes: deltas.reduce((s, d) => s + deltaBytes(d), 0) };
  }

  /** Add a new entry (drops the redo branch and the oldest entries over the caps). */
  push(rec: StrokeRecord): void {
    for (const r of this.redoStack) this.bytes -= r.bytes;
    this.redoStack = [];
    this.undoStack.push(rec);
    this.bytes += rec.bytes;
    while (this.undoStack.length > 1 && (this.undoStack.length > this.maxStrokes || this.bytes > this.maxBytes)) {
      this.bytes -= this.undoStack.shift()!.bytes;
    }
    if (this.undoStack.length > this.maxStrokes || this.bytes > this.maxBytes) {
      // A single entry over the memory cap: keep nothing (it stays applied).
      this.bytes -= this.undoStack.pop()!.bytes;
    }
  }

  /** Revert the latest entry; returns it (null when empty). */
  undo(): StrokeRecord | null {
    const rec = this.undoStack.pop();
    if (!rec) return null;
    for (let i = rec.deltas.length - 1; i >= 0; i--) rec.deltas[i].mesh.applyDelta(rec.deltas[i], 'old');
    this.redoStack.push(rec);
    return rec;
  }

  redo(): StrokeRecord | null {
    const rec = this.redoStack.pop();
    if (!rec) return null;
    for (const d of rec.deltas) d.mesh.applyDelta(d, 'new');
    this.undoStack.push(rec);
    return rec;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.bytes = 0;
  }
}

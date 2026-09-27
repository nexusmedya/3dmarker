/**
 * Undo / redo for the rig editor: a bounded stack of reversible entries.
 * Entries may be asynchronous (a skeleton change re-binds the mesh or waits
 * for the weight worker); undo / redo run one at a time — a request while
 * one runs is queued behind it, so fast Ctrl+Z presses apply in order.
 */
export interface HistoryEntry {
  /** Shown in the undo / redo button titles. */
  label: string;
  undo(): void | Promise<void>;
  redo(): void | Promise<void>;
  /** Approximate memory held (bytes), for the size budget. */
  bytes?: number;
}

export interface HistoryState {
  undo: number;
  redo: number;
  undoLabel: string | null;
  redoLabel: string | null;
  busy: boolean;
}

export class EditHistory {
  private done: HistoryEntry[] = [];
  private undone: HistoryEntry[] = [];
  private chain: Promise<void> = Promise.resolve();
  private running = 0;
  onChange: ((s: HistoryState) => void) | null = null;

  constructor(
    readonly limit = 100,
    /** Memory budget of the stored entries (oldest dropped beyond it). */
    readonly maxBytes = 256 * 1024 * 1024,
  ) {}

  get state(): HistoryState {
    return {
      undo: this.done.length,
      redo: this.undone.length,
      undoLabel: this.done[this.done.length - 1]?.label ?? null,
      redoLabel: this.undone[this.undone.length - 1]?.label ?? null,
      busy: this.running > 0,
    };
  }

  /** Record an edit that was already applied (clears the redo stack). */
  push(e: HistoryEntry): void {
    this.done.push(e);
    this.undone = [];
    let bytes = this.done.reduce((t, x) => t + (x.bytes ?? 0), 0);
    while (this.done.length > this.limit || (bytes > this.maxBytes && this.done.length > 1)) {
      bytes -= this.done.shift()!.bytes ?? 0;
    }
    this.emit();
  }

  undo(): Promise<boolean> {
    return this.run(this.done, this.undone, 'undo');
  }

  redo(): Promise<boolean> {
    return this.run(this.undone, this.done, 'redo');
  }

  clear(): void {
    this.done = [];
    this.undone = [];
    this.emit();
  }

  private run(from: HistoryEntry[], to: HistoryEntry[], kind: 'undo' | 'redo'): Promise<boolean> {
    const job = this.chain.then(async () => {
      const e = from.pop();
      if (!e) return false;
      this.running++;
      this.emit();
      try {
        await e[kind]();
        to.push(e);
        return true;
      } catch (err) {
        // A failed step is dropped (its state is unknown); the rest of the history stays usable.
        console.warn(`[rig editor] ${kind} failed`, err);
        return false;
      } finally {
        this.running--;
        this.emit();
      }
    });
    this.chain = job.then(() => undefined, () => undefined);
    return job;
  }

  private emit(): void {
    this.onChange?.(this.state);
  }
}

import type { FlipchartPublicNote } from './types';

type Update<T> = { cursor: number; reset: boolean; notes: T[]; removedIds: string[] };
type Acknowledgement<T> = { cursor: number; note: T };

/**
 * A mutation acknowledges one note, not the whole board. Never move the read
 * cursor on that acknowledgement: other people's changes may lie in between.
 * Per-note cursors also protect acknowledged votes from an older in-flight read.
 */
export class FlipchartReplica<T extends FlipchartPublicNote> {
  cursor: number | null = null;
  private values = new Map<string, T>();
  private applied = new Map<string, number>();

  notes(): T[] {
    return [...this.values.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  reset() {
    this.cursor = null;
    this.values.clear();
    this.applied.clear();
  }

  private apply(note: T, cursor: number) {
    if ((this.applied.get(note.id) ?? -1) > cursor) return;
    this.applied.set(note.id, cursor);
    if (note.status === 'active') this.values.set(note.id, note);
    else this.values.delete(note.id);
  }

  acknowledge(result: Acknowledgement<T>) {
    // A later snapshot may already include a removal of this very note.
    if (this.cursor !== null && result.cursor < this.cursor) return;
    this.apply(result.note, result.cursor);
  }

  update(result: Update<T>) {
    if (this.cursor !== null && result.cursor < this.cursor) return;
    if (result.reset) {
      const present = new Set(result.notes.map(note => note.id));
      for (const id of this.values.keys()) {
        if (!present.has(id) && (this.applied.get(id) ?? -1) <= result.cursor) {
          this.values.delete(id);
          this.applied.set(id, result.cursor);
        }
      }
    }
    for (const note of result.notes) this.apply(note, result.cursor);
    for (const id of result.removedIds) {
      if ((this.applied.get(id) ?? -1) > result.cursor) continue;
      this.values.delete(id);
      this.applied.set(id, result.cursor);
    }
    this.cursor = result.cursor;
  }
}

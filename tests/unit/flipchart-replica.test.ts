import { describe, expect, it } from 'vitest';
import { FlipchartReplica } from '../../packages/flipchart/replica';
import type { FlipchartNote } from '../../packages/flipchart/types';

const note = (id: string, patch: Partial<FlipchartNote> = {}): FlipchartNote => ({
  id, kind: 'barrier', text: 'Нет своего жилья', status: 'active',
  createdAt: '2026-11-09T12:00:00Z', revision: 1, support: 0, oppose: 0, score: 0,
  myVote: null, myVoteRevision: 0, canWithdraw: true, ...patch,
});
const update = (cursor: number, notes: FlipchartNote[], reset = false, removedIds: string[] = []) => ({
  cursor, notes, reset, removedIds,
});

describe('flipchart delta consistency', () => {
  it('does not skip another participant’s intervening note when a mutation acknowledges a later cursor', () => {
    const replica = new FlipchartReplica<FlipchartNote>();
    replica.update(update(3, [note('a')], true));
    replica.acknowledge({ cursor: 5, note: note('c') });
    expect(replica.cursor).toBe(3);
    replica.update(update(5, [note('b'), note('c')]));
    expect(replica.notes().map(item => item.id)).toEqual(['a', 'b', 'c']);
    expect(replica.cursor).toBe(5);
  });

  it('does not overwrite an acknowledged vote with an older in-flight read or reset', () => {
    const replica = new FlipchartReplica<FlipchartNote>();
    replica.update(update(1, [note('a')], true));
    const voted = note('a', { support: 1, score: 1, myVote: 1, myVoteRevision: 1 });
    replica.acknowledge({ cursor: 4, note: voted });
    replica.update(update(2, [note('a'), note('b')], true));
    expect(replica.notes().find(item => item.id === 'a')).toEqual(voted);
    expect(replica.notes().some(item => item.id === 'b')).toBe(true);
    replica.update(update(4, [voted]));
    expect(replica.cursor).toBe(4);
  });

  it('protects removals against delayed acknowledgements and older note content', () => {
    const replica = new FlipchartReplica<FlipchartNote>();
    replica.update(update(1, [note('a')], true));
    replica.acknowledge({ cursor: 4, note: note('a', { status: 'withdrawn', revision: 2 }) });
    replica.update(update(2, [note('a')]));
    expect(replica.notes()).toEqual([]);
    replica.update(update(4, [], false, ['a']));
    replica.acknowledge({ cursor: 3, note: note('a') });
    expect(replica.notes()).toEqual([]);
    replica.acknowledge({ cursor: 5, note: note('a', { revision: 3 }) });
    expect(replica.notes()[0]?.revision).toBe(3);
  });

  it('keeps a new local acknowledgement missing from an older reset, then applies a later authoritative reset', () => {
    const replica = new FlipchartReplica<FlipchartNote>();
    replica.acknowledge({ cursor: 4, note: note('a') });
    replica.update(update(2, [], true));
    expect(replica.notes()).toHaveLength(1);
    replica.update(update(6, [], true));
    expect(replica.notes()).toEqual([]);
    replica.acknowledge({ cursor: 5, note: note('a') });
    expect(replica.notes()).toEqual([]);
  });
});

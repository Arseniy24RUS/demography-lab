import { describe, expect, it } from 'vitest';
import { WorkshopApi } from '../../apps/web/src/lib/workshop-api';
import type { SessionApi } from '../../apps/web/src/lib/session-api';

const sessionId = '11111111-1111-4111-8111-111111111111';
const roundId = '22222222-2222-4222-8222-222222222222';
const familyId = '33333333-3333-4333-8333-333333333333';
const timestamp = '2026-11-08T15:00:00.000Z';
const variant = {
  submissionId: '44444444-4444-4444-8444-444444444444', submissionRevision: 1,
  bundle: { schemaVersion: 1, note: '',
    practice: { id: 'practice', familyId: 'family', regionId: 'region', title: 'Присмотр за детьми', mechanism: 'Кратковременный присмотр', occurrenceIds: ['occurrence'] },
    occurrences: [{ id: 'occurrence', documentId: 'document', versionId: 'edition', reviewStatus: 'candidate',
      anchor: { id: 'anchor', documentId: 'document', versionId: 'edition', normalizationVersion: 'unicode-nfc-lf-v1', spans: [{ blockId: 'block', start: 0, end: 3, exact: 'АБВ', prefix: '', suffix: '' }] } }],
    sources: [{ sourceId: 'document', editionId: 'edition', title: 'Программа', normalizationVersion: 'unicode-nfc-lf-v1', regionId: 'region' }],
  },
};
function snapshot(compact = false) {
  return { sessionId, cursor: compact ? 2 : 1, boardRevision: 1, regionWork: [], families: [], rounds: [], round: {
    id: roundId, title: 'Приоритеты', status: 'open', resultsVisibility: 'after_close', promptText: 'Какие практики приоритетны?',
    contextScope: 'region', contextRegionId: 'region', evaluationDimension: 'priority_for_adaptation', minCoverage: .7, minSubstantiveVotes: 2,
    revision: 1, eligibleCount: 2, familyCount: 1, openedAt: timestamp, closedAt: null, canVote: true, totalsVisible: false, participatingCount: compact ? 1 : 0,
    families: [{ id: familyId, title: 'Присмотр', mechanism: 'Кратковременный присмотр', rationale: 'Сопоставимые механизмы', variants: compact ? null : [structuredClone(variant)], totals: null, myVote: compact ? 1 : null, myVoteRevision: compact ? 1 : 0 }],
  } };
}
function client(responses: unknown[]) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const transport = { rpc: async (name: string, args: Record<string, unknown>, parse: (value: unknown) => unknown) => { calls.push({ name, args }); return parse(responses.shift()); } } as unknown as SessionApi;
  return { api: new WorkshopApi(transport), calls };
}
describe('immutable round materials and compact updates', () => {
  it('downloads exact materials once and reuses them only for the same frozen round/family', async () => {
    const { api, calls } = client([snapshot(), snapshot(true)]);
    const original = await api.snapshot(sessionId);
    const updated = await api.snapshot(sessionId);
    expect(calls.map((call) => call.args.p_known_round_id)).toEqual([null, roundId]);
    expect(updated.round!.families[0].variants).toEqual(original.round!.families[0].variants);
    expect(updated.round!.families[0].myVote).toBe(1);
    expect(updated.cursor).toBe(2);
  });
  it('refuses to attach cached citations to a different family', async () => {
    const changed = snapshot(true);
    changed.round.families[0].id = '55555555-5555-4555-8555-555555555555';
    const { api, calls } = client([snapshot(), changed, snapshot()]);
    await api.snapshot(sessionId);
    await expect(api.snapshot(sessionId)).rejects.toThrow('повторной загрузки');
    await api.snapshot(sessionId);
    expect(calls[2].args.p_known_round_id).toBe(null);
  });
  it('a new authenticated client never inherits another client’s material cache', async () => {
    const first = client([snapshot()]);
    await first.api.snapshot(sessionId);
    const second = client([snapshot(true)]);
    await expect(second.api.snapshot(sessionId)).rejects.toThrow('повторной загрузки');
    expect(second.calls[0].args.p_known_round_id).toBe(null);
  });
  it('rejects an otherwise valid response for another teaching session', async () => {
    const wrong = snapshot(); wrong.sessionId = '66666666-6666-4666-8666-666666666666';
    await expect(client([wrong]).api.snapshot(sessionId)).rejects.toThrow('другому занятию');
  });
});

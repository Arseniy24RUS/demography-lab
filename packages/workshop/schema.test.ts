import { describe, expect, it } from 'vitest';
import { parseVotingRound, parseWorkshopProjection, parseWorkshopSnapshot } from './schema';
import type { VotingRound, WorkshopProjection, WorkshopSnapshot } from './types';

const sid = '00000000-0000-4000-8000-000000000001';
const rid = '00000000-0000-4000-8000-000000000002';
const fid = '00000000-0000-4000-8000-000000000003';
const sub = '00000000-0000-4000-8000-000000000004';
const now = '2026-11-08T15:00:00.000Z';
function fixture(): WorkshopSnapshot {
  const round: VotingRound = {
    id: rid, title: 'Учебный раунд', status: 'open', resultsVisibility: 'after_close',
    promptText: 'Приоритетна ли адаптация практики?', contextScope: 'region', contextRegionId: 'region',
    evaluationDimension: 'priority_for_adaptation', minCoverage: .7, minSubstantiveVotes: 1,
    revision: 1, eligibleCount: 2, familyCount: 1, openedAt: now, closedAt: null,
    canVote: true, totalsVisible: false, participatingCount: 0,
    families: [{ id: fid, title: 'Механизм', mechanism: 'Описание', rationale: 'Основание',
      totals: null, myVote: null, myVoteRevision: 0,
      variants: [{ submissionId: sub, submissionRevision: 1, bundle: {
        schemaVersion: 1, note: '', practice: { id: 'practice', familyId: 'family', regionId: 'region',
          title: 'Учебная карточка', mechanism: 'Описание', occurrenceIds: ['occurrence'] },
        occurrences: [{ id: 'occurrence', documentId: 'document', versionId: 'version', reviewStatus: 'candidate',
          anchor: { id: 'anchor', documentId: 'document', versionId: 'version', normalizationVersion: 'unicode-nfc-lf-v1',
            spans: [{ blockId: 'block', start: 0, end: 5, exact: 'Текст', prefix: '', suffix: '' }] } }],
        sources: [{ sourceId: 'document', editionId: 'version', title: 'Учебный источник', normalizationVersion: 'unicode-nfc-lf-v1' }],
      } }],
    }],
  };
  const { canVote: _can, totalsVisible: _visible, participatingCount: _count, families: _families, ...summary } = round;
  return { sessionId: sid, cursor: 5, boardRevision: 1, regionWork: [],
    families: [{ id: fid, title: 'Механизм', mechanism: 'Описание', rationale: 'Основание', submissionIds: [sub], revision: 1, createdAt: now, updatedAt: now }],
    rounds: [summary], round };
}
function projection(): WorkshopProjection {
  const s = fixture(); const { canVote: _can, ...round } = s.round!;
  return { sessionId: sid, title: 'Занятие', phase: 'discussion', status: 'open', cursor: 5,
    regionWork: [], familyCount: 1, groupedSubmissionCount: 1,
    round: { ...round, families: round.families.map(({ myVote: _mine, myVoteRevision: _rev, ...f }) => f) } };
}

describe('Workshop transport boundaries', () => {
  it('preserves explicit neutral separately from no answer', () => {
    const s = fixture();
    expect(parseWorkshopSnapshot(s).round!.families[0].myVote).toBeNull();
    s.round!.families[0].myVote = 0; s.round!.families[0].myVoteRevision = 1;
    expect(parseWorkshopSnapshot(s).round!.families[0].myVote).toBe(0);
  });

  it('rejects leaked per-family totals in a blind active round', () => {
    const s = fixture();
    s.round!.families[0].totals = { support: 0, oppose: 0, neutral: 0, unanswered: 2,
      cast: 0, score: 0, substantive: 0, coverage: 0, supportRatio: null, net: null, qualifies: false };
    expect(() => parseVotingRound(s.round)).toThrow('несовместимые');
  });

  it('rejects wrong denominators and an unexplained eligibility flag', () => {
    const s = fixture(); const r = s.round!;
    r.status = 'closed'; r.closedAt = now; r.totalsVisible = true; r.canVote = false;
    r.families[0].totals = { support: 1, oppose: 0, neutral: 0, unanswered: 1,
      cast: 1, score: 1, substantive: 1, coverage: .5, supportRatio: 1, net: 1, qualifies: false };
    expect(parseVotingRound(r).families[0].totals!.qualifies).toBe(false);
    r.families[0].totals!.unanswered = 0;
    expect(() => parseVotingRound(r)).toThrow();
    r.families[0].totals!.unanswered = 1; r.families[0].totals!.qualifies = true;
    expect(() => parseVotingRound(r)).toThrow();
    r.families[0].totals!.qualifies = false; r.families[0].totals!.coverage = .4;
    expect(() => parseVotingRound(r)).toThrow();
    r.families[0].totals!.coverage = .5; r.families[0].totals!.net = .5;
    expect(() => parseVotingRound(r)).toThrow();
  });

  it('refuses personal identifiers and ballot fields on projector DTOs', () => {
    const p = projection(); expect(parseWorkshopProjection(p).round!.families.length).toBe(1);
    expect(() => parseWorkshopProjection({ ...p, members: [{ userId: sid }] })).toThrow();
    const leaked = structuredClone(p) as unknown as { round: { families: Array<Record<string, unknown>> } };
    leaked.round.families[0].myVote = 1;
    expect(() => parseWorkshopProjection(leaked)).toThrow();
  });

  it('rejects duplicate family assignments and incompatible allocation leases', () => {
    const s = fixture(); s.families.push({ ...s.families[0], id: rid });
    expect(() => parseWorkshopSnapshot(s)).toThrow();
    const duplicateFrozen = fixture(); duplicateFrozen.round!.familyCount = 2;
    duplicateFrozen.round!.families.push({ ...duplicateFrozen.round!.families[0], id: sub });
    expect(() => parseVotingRound(duplicateFrozen.round)).toThrow();
    const broken = fixture();
    broken.regionWork = [{ regionId: 'region', ownerId: sid, ownerName: 'Автор', status: 'in_progress',
      leaseExpiresAt: null, completionNote: '', revision: 1, updatedAt: now }];
    expect(() => parseWorkshopSnapshot(broken)).toThrow();
  });

  it('requires hydration of compact immutable materials before accepting the domain snapshot', () => {
    const compact = fixture() as unknown as { round: { families: Array<Record<string, unknown>> } };
    compact.round.families[0].variants = null;
    expect(() => parseWorkshopSnapshot(compact)).toThrow();
  });
});

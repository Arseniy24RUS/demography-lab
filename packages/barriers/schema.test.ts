import { describe, expect, it } from 'vitest';
import {
  parseBarrierEvidence, parseBarriersProjection, parseBarriersSnapshot, parseSurveyHostState,
  parseSurveyOwnResponse, parseSurveyPublicManifest, parseSurveyResearchExport, parseSurveyInvitationState,
  saveBarrierInputSchema, saveBarrierLinkInputSchema, surveyResponseInputSchema,
} from './schema';
import type { BarrierCard, BarrierEvidence, BarriersSnapshot, SurveyAnswerFields, SurveyPublicManifest, SurveyResearchExport } from './types';

const sid = '00000000-0000-4000-8000-000000000001';
const bid = '00000000-0000-4000-8000-000000000002';
const fid = '00000000-0000-4000-8000-000000000003';
const eid = '00000000-0000-4000-8000-000000000004';
const lid = '00000000-0000-4000-8000-000000000005';
const fingerprint = 'a'.repeat(64); const now = '2026-11-08T12:00:00.000Z';
function barrier(): BarrierCard {
  return { id: bid, authorId: sid, authorName: 'Участник занятия', title: 'Недоступность услуг ухода', description: 'Проверяем гипотезу в обсуждении.',
    primaryStage: 'early_childhood', stageIds: ['early_childhood', 'next_child'], evidenceKind: 'hypothesis', status: 'active', priority: false,
    revision: 1, contentRevision: 1, totals: { support: 1, oppose: 0, neutral: 1, cast: 2 }, myVote: 0, myVoteRevision: 1, createdAt: now, updatedAt: now };
}
function snapshot(): BarriersSnapshot {
  return { sessionId: sid, cursor: 1, barriers: [barrier()],
    families: [{ id: fid, title: 'Компенсация расходов', mechanism: 'Уменьшение текущих расходов семьи.', revision: 1, fingerprint, variantCount: 1, regionNames: ['Республика Мордовия'] }],
    links: [{ id: lid, barrierId: bid, familyId: fid, authorId: sid, authorName: 'Участник занятия', relationship: 'partial', explanation: 'Может помочь покрыть часть расходов.',
      prerequisites: 'Проверить условия адаптации.', status: 'active', revision: 1, barrierContentRevision: 1, evidenceId: eid, familyFingerprint: fingerprint,
      familyTitle: 'Компенсация расходов', staleReasons: [], createdAt: now, updatedAt: now }], solutions: [], survey: null };
}
function manifest(): SurveyPublicManifest {
  return { id: sid, title: 'Условия родительства', purpose: 'Учебное обсуждение препятствий и возможных решений.', organizerContact: 'contact@example.test',
    retentionUntil: '2026-12-01', status: 'open', expired: false, canRespond: true, questionVersion: 1,
    questionnaireVersion: 'demography-open-1', procedureVersion: 'classroom-open-link-1',
    questions: { q00: 'От чьего имени Вы отвечаете?', q05_12m: 'Намерение на 12 месяцев', q05_36m: 'Намерение на 36 месяцев',
      q01: 'Что затрудняет родительство?', q02: 'Что могло бы помочь родительству?', q03: 'Приоритетное условие', q04: 'Горизонт изменений',
      q06: 'Условное изменение намерения', q07: 'Дополнительные условия', q08: 'Добровольные согласия' } };
}
function answers(): SurveyAnswerFields {
  return { perspective: 'self', intention12m: null, intention36m: 'unsure', answerBarrier: 'Недоступные услуги ухода', answerSupport: null,
    priorityChange: null, priorityConditionId: null, horizon: null, conditionalChange: null, additionalConditions: null,
    consentEducational: true, consentResearch: false, consentQuote: false, adultConfirmed: true };
}
const blank = (): SurveyAnswerFields => ({ ...answers(), perspective: 'decline', intention36m: null, answerBarrier: null, consentEducational: false, adultConfirmed: false });

describe('Stage 4 transport and privacy boundaries', () => {
  it('accepts current links while rejecting hidden staleness and forged discussion totals', () => {
    expect(parseBarriersSnapshot(snapshot()).links[0].staleReasons).toEqual([]);
    const changed = snapshot(); changed.families[0].fingerprint = 'b'.repeat(64);
    expect(() => parseBarriersSnapshot(changed)).toThrow();
    changed.links[0].staleReasons = ['family_changed']; expect(parseBarriersSnapshot(changed).links[0].staleReasons).toEqual(['family_changed']);
    changed.barriers[0].contentRevision = 2; changed.barriers[0].revision = 2;
    expect(() => parseBarriersSnapshot(changed)).toThrow();
    changed.links[0].staleReasons.push('barrier_changed'); expect(() => parseBarriersSnapshot(changed)).not.toThrow();
    changed.barriers[0].totals.cast = 99; expect(() => parseBarriersSnapshot(changed)).toThrow();
  });
  it('does not allow bundles in frequent metadata responses or unknown target barrier IDs', () => {
    const s = snapshot();
    expect(() => parseBarriersSnapshot({ ...s, links: [{ ...s.links[0], variants: [] }] })).toThrow();
    expect(() => parseBarriersSnapshot({ ...s, links: [{ ...s.links[0], barrierId: sid }] })).toThrow();
    s.families = []; s.links[0].staleReasons = ['family_missing']; expect(() => parseBarriersSnapshot(s)).not.toThrow();
    s.links.push({ ...s.links[0] }); expect(() => parseBarriersSnapshot(s)).toThrow();
  });
  it('rejects private survey and named identity fields in a projector DTO', () => {
    const { authorId: _author, myVote: _vote, myVoteRevision: _voteRevision, ...b } = barrier();
    const p = { sessionId: sid, title: 'Совместная работа', scope: 'municipality', regionId: 'respublika-mordoviia', phase: 'reading', status: 'open', cursor: 1,
      barriers: [{ ...b, authorName: null }], families: [], links: [], solutions: [], survey: { title: 'Условия родительства', status: 'open', responseCount: null } };
    expect(() => parseBarriersProjection(p)).not.toThrow();
    expect(() => parseBarriersProjection({ ...p, survey: { ...p.survey, id: sid } })).toThrow();
    expect(() => parseBarriersProjection({ ...p, survey: { ...p.survey, responseCount: 4 } })).toThrow();
    expect(() => parseBarriersProjection({ ...p, barriers: [{ ...p.barriers[0], authorId: sid }] })).toThrow();
    expect(() => parseBarriersProjection({ ...p, responses: [answers()] })).toThrow();
  });
  it('requires immutable evidence to have complete validated variants rather than null material', () => {
    const e: BarrierEvidence = { id: eid, sessionId: sid, familyId: fid, fingerprint, familyRevision: 1, title: 'Компенсация', mechanism: 'Возмещение расходов', rationale: 'Исходные условия сохранены',
      variants: [{ submissionId: lid, submissionRevision: 1, bundle: { schemaVersion: 1, note: '',
        practice: { id: 'practice', familyId: 'family', regionId: 'region', title: 'Учебная карточка', mechanism: 'Описание', occurrenceIds: ['occurrence'] },
        occurrences: [{ id: 'occurrence', documentId: 'document', versionId: 'version', reviewStatus: 'candidate',
          anchor: { id: 'anchor', documentId: 'document', versionId: 'version', normalizationVersion: 'unicode-nfc-lf-v1',
            spans: [{ blockId: 'block', start: 0, end: 5, exact: 'Текст', prefix: '', suffix: '' }] } }],
        sources: [{ sourceId: 'document', editionId: 'version', title: 'Учебный источник', normalizationVersion: 'unicode-nfc-lf-v1' }] } }] };
    expect(() => parseBarrierEvidence(e)).not.toThrow();
    expect(() => parseBarrierEvidence({ ...e, variants: null })).toThrow();
    expect(() => parseBarrierEvidence({ ...e, variants: [] })).toThrow();
    expect(() => parseBarrierEvidence({ ...e, variants: [...e.variants, ...e.variants] })).toThrow();
  });
  it('validates the lifecycle set and prevents numeric/fingerprint coercion in commands', () => {
    const b = barrier(); const input = { barrierId: b.id, expectedRevision: b.revision, title: b.title, description: b.description,
      primaryStage: b.primaryStage, stageIds: b.stageIds, evidenceKind: b.evidenceKind, status: b.status, priority: b.priority };
    expect(saveBarrierInputSchema.safeParse(input).success).toBe(true);
    for (const patch of [{ stageIds: ['next_child'] }, { stageIds: [...b.stageIds, 'next_child'] }, { expectedRevision: '1' },
      { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { title: ' '.repeat(10) }, { authorId: sid }])
      expect(saveBarrierInputSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    expect(saveBarrierLinkInputSchema.safeParse({ linkId: null, expectedRevision: 0, barrierId: bid, expectedBarrierRevision: 1, familyId: fid,
      expectedFamilyFingerprint: fingerprint, relationship: 'partial', explanation: 'Частично решает проблему', prerequisites: '', status: 'active' }).success).toBe(true);
  });
  it('does not carry intentions to proxy perspectives and keeps independent research/quote consent', () => {
    const input = { ...answers(), expectedRevision: 0, questionVersion: 1 };
    expect(surveyResponseInputSchema.safeParse(input).success).toBe(true);
    for (const patch of [{ perspective: 'adult_child_reported' }, { consentQuote: true }, { consentEducational: false }, { adultConfirmed: false },
      { conditionalChange: 'probably_change' }, { priorityChange: 'Доступное жильё' }, { perspective: 'decline' }, { answerBarrier: null, answerSupport: null }])
      expect(surveyResponseInputSchema.safeParse({ ...input, ...patch }).success).toBe(false);
    expect(surveyResponseInputSchema.safeParse({ ...input, perspective: 'adult_child_inferred', intention36m: null }).success).toBe(true);
    expect(surveyResponseInputSchema.safeParse({ ...input, priorityChange: 'Доступное жильё', priorityConditionId: eid, conditionalChange: 'unsure' }).success).toBe(true);
  });
  it('rejects raw contents in withdrawn, expired and purged receipts and refuses transport identifiers', () => {
    const submitted = { ...answers(), status: 'submitted', revision: 1, questionVersion: 1, availability: 'open' };
    expect(() => parseSurveyOwnResponse(submitted)).not.toThrow();
    expect(() => parseSurveyOwnResponse({ ...submitted, availability: 'expired' })).toThrow();
    expect(() => parseSurveyOwnResponse({ ...submitted, status: 'withdrawn' })).toThrow();
    expect(() => parseSurveyOwnResponse({ ...submitted, secret: fingerprint })).toThrow();
    expect(() => parseSurveyOwnResponse({ ...blank(), status: 'withdrawn', revision: 2, questionVersion: 1, availability: 'purged' })).not.toThrow();
    expect(() => parseSurveyOwnResponse({ ...blank(), status: 'none', revision: 0, questionVersion: 1, availability: 'open' })).not.toThrow();
  });
  it('requires suppressed low counts and consistent host consent totals and forbids expired raw rows', () => {
    const survey = { ...manifest(), revision: 2, responseCount: null };
    const state = { survey, invitationDigest: fingerprint, responseCount: 1, researchCount: 0, quoteCount: 0,
      responses: [{ ...answers(), rowKey: bid, revision: 1, questionVersion: 1, responseDate: '2026-11-08' }] };
    expect(() => parseSurveyHostState(state)).not.toThrow();
    expect(() => parseSurveyHostState({ ...state, researchCount: 1 })).toThrow();
    expect(() => parseSurveyHostState({ ...state, survey: { ...survey, responseCount: 1 } })).toThrow();
    expect(() => parseSurveyHostState({ ...state, survey: { ...survey, expired: true, canRespond: false } })).toThrow();
    expect(() => parseSurveyPublicManifest({ ...manifest(), retentionUntil: '2026-02-30' })).toThrow();
    expect(parseSurveyInvitationState({ surveyId: sid, invitationDigest: fingerprint })).toEqual({ surveyId: sid, invitationDigest: fingerprint });
    expect(() => parseSurveyInvitationState({ surveyId: sid, invitationDigest: fingerprint, responses: state.responses })).toThrow();
  });
  it('refuses non-consented export rows and leaked receipt IDs', () => {
    const { priorityConditionId: _condition, consentEducational: _education, adultConfirmed: _adult, ...record } = answers();
    const exp: SurveyResearchExport = { datasetVersion: 'demography-research-export-1', procedureVersion: 'classroom-open-link-1', exportDate: '2026-11-08',
      samplingNote: 'Добровольная открытая учебная выборка, не репрезентативная.', questionnaire: manifest(),
      missingCodes: { skipped: 'null', notAsked: 'not_asked', notApplicable: 'not_applicable', declined: 'decline' },
      records: [{ ...record, consentResearch: true, questionVersion: 1, responseDate: '2026-11-08', missingReasons: { intention12m: 'skipped', conditionalChange: 'not_asked' } }] };
    expect(() => parseSurveyResearchExport(exp)).not.toThrow();
    expect(() => parseSurveyResearchExport({ ...exp, records: [{ ...exp.records[0], consentResearch: false }] })).toThrow();
    expect(() => parseSurveyResearchExport({ ...exp, records: [{ ...exp.records[0], rowKey: bid }] })).toThrow();
  });
});

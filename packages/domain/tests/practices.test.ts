import { describe, expect, it } from 'vitest';
import {
  createAnchor,
  evaluateFieldEvidence,
  evaluatePracticeEvidence,
  getPracticeFieldValue,
  rankPracticeCandidates,
  type PracticeOccurrence,
  type PracticeVariant,
} from '../index';
import { makeVariant, makeVersion } from './fixtures';

function evidenceFixture() {
  const version = makeVersion([
    'Семьям предоставляется земельный участок. Сумма выплаты 100 000 рублей.',
  ]);
  const anchor = createAnchor(version, [{ blockId: 'b0', start: 0, end: 41 }]);
  const occurrence: PracticeOccurrence = {
    id: 'o1',
    documentId: version.documentId,
    versionId: version.id,
    anchor,
    reviewStatus: 'verified',
  };
  const variant = makeVariant({ occurrenceIds: ['o1'] });
  return {
    version,
    anchor,
    occurrence,
    variant,
    context: { versions: [version], occurrences: [occurrence] },
  };
}

describe('field-level evidence', () => {
  it('requires an exact, current field value, valid source and explicit human verification', () => {
    const { variant, context } = evidenceFixture();
    const reviewed: PracticeVariant = {
      ...variant,
      evidence: [
        {
          kind: 'fragment',
          field: 'title',
          occurrenceId: 'o1',
          relation: 'supports',
          reviewStatus: 'verified',
          reviewedValue: variant.title,
        },
      ],
    };
    expect(evaluateFieldEvidence(reviewed, 'title', context).status).toBe('supported');
    expect(
      evaluateFieldEvidence({ ...reviewed, title: 'Новая сумма 500 000' }, 'title', context).status,
    ).toBe('partial');
    expect(evaluateFieldEvidence(reviewed, 'amount', context).status).toBe('unsupported');
    expect(evaluateFieldEvidence({ ...reviewed, amount: null }, 'amount', context).status).toBe(
      'unknown',
    );
  });
  it('does not upgrade article or entire-document references to field proof', () => {
    const { variant, context, version } = evidenceFixture();
    const secondary: PracticeVariant = {
      ...variant,
      evidence: [{ kind: 'article', field: 'amount', url: 'https://example.org/article' }],
    };
    expect(evaluateFieldEvidence(secondary, 'amount', context).status).toBe('partial');
    expect(evaluateFieldEvidence(secondary, 'title', context).status).toBe('unsupported');
    expect(
      evaluateFieldEvidence(
        {
          ...variant,
          evidence: [
            {
              kind: 'document',
              field: 'amount',
              documentId: version.documentId,
              versionId: version.id,
            },
          ],
        },
        'amount',
        context,
      ).status,
    ).toBe('partial');
    expect(
      evaluateFieldEvidence(
        {
          ...variant,
          evidence: [{ kind: 'article', field: 'amount', url: 'javascript:alert(1)' }],
        },
        'amount',
        context,
      ).status,
    ).toBe('unsupported');
  });
  it('rejects fabricated quotations and cross-edition links even if marked verified', () => {
    const { variant, occurrence, context } = evidenceFixture();
    const reviewed: PracticeVariant = {
      ...variant,
      evidence: [
        {
          kind: 'fragment',
          field: 'amount',
          occurrenceId: 'o1',
          relation: 'supports',
          reviewStatus: 'verified',
          reviewedValue: variant.amount!,
        },
      ],
    };
    const bad = {
      ...occurrence,
      anchor: {
        ...occurrence.anchor,
        spans: [{ ...occurrence.anchor.spans[0]!, exact: 'Вымышленная цитата' }],
      },
    };
    expect(
      evaluateFieldEvidence(reviewed, 'amount', { ...context, occurrences: [bad] }).status,
    ).toBe('unsupported');
    expect(
      evaluateFieldEvidence(reviewed, 'amount', {
        ...context,
        occurrences: [{ ...occurrence, versionId: 'unrelated' }],
      }).status,
    ).toBe('unsupported');
    expect(
      evaluateFieldEvidence({ ...reviewed, occurrenceIds: [] }, 'amount', context).status,
    ).toBe('unsupported');
  });
  it('keeps conditions and eligibility independently reviewable, surfacing contradiction', () => {
    const { variant, context } = evidenceFixture();
    const reviewed: PracticeVariant = {
      ...variant,
      evidence: [
        {
          kind: 'fragment',
          field: 'conditions',
          occurrenceId: 'o1',
          relation: 'supports',
          reviewStatus: 'verified',
          reviewedValue: getPracticeFieldValue(variant, 'conditions')!,
        },
        {
          kind: 'fragment',
          field: 'amount',
          occurrenceId: 'o1',
          relation: 'contradicts',
          reviewStatus: 'verified',
          reviewedValue: variant.amount!,
        },
      ],
    };
    const all = evaluatePracticeEvidence(reviewed, context);
    expect(all.conditions.status).toBe('supported');
    expect(all.eligibility.status).toBe('unsupported');
    expect(all.amount.status).toBe('contradicted');
    expect(
      evaluateFieldEvidence(
        { ...reviewed, conditions: ['Другой срок проживания'] },
        'conditions',
        context,
      ).status,
    ).toBe('partial');
  });
});

describe('conservative practice suggestions', () => {
  it('does not infer association from a generic family-support word', () => {
    const version = makeVersion(['Поддержка семьи']);
    const anchor = createAnchor(version, [{ blockId: 'b0', start: 0, end: 15 }]);
    expect(
      rankPracticeCandidates(version, anchor, [makeVariant({ title: 'Поддержка семьи' })]),
    ).toEqual([]);
  });
  it('ranks explicit same-edition evidence above lexical similarity, always requiring confirmation', () => {
    const { version, anchor, occurrence, variant } = evidenceFixture();
    const lexical = makeVariant({ id: 'a-lexical', occurrenceIds: [] });
    const results = rankPracticeCandidates(version, anchor, [lexical, variant], [occurrence]);
    expect(results[0]!.variantId).toBe(variant.id);
    expect(results[0]!.reasons).toContain('same_edition_source_overlap');
    expect(
      results.every(
        (candidate) => candidate.linkStatus === 'candidate' && candidate.requiresConfirmation,
      ),
    ).toBe(true);
  });
  it('distinguishes regional amounts and conditions rather than treating variants as duplicates', () => {
    const version = makeVersion(['Предоставление земельного участка и компенсация выплаты']);
    const anchor = createAnchor(version, [
      { blockId: 'b0', start: 0, end: Array.from(version.blocks[0]!.text).length },
    ]);
    const base = makeVariant();
    const other = makeVariant({
      id: 'other',
      regionId: '77',
      amount: '500 000 рублей',
      conditions: ['Без требования проживания'],
    });
    const results = rankPracticeCandidates(version, anchor, [other, base], [], {
      expected: { regionId: '13', amount: '100 000 рублей', conditions: base.conditions },
    });
    expect(results[0]!.variantId).toBe(base.id);
    expect(results.find((result) => result.variantId === 'other')!.reasons).toContain(
      'amount_differs',
    );
    expect(results).toHaveLength(2);
  });
  it('does not promote a corrupted source or reject reproducible stable tie-breaking', () => {
    const { version, anchor, occurrence, variant } = evidenceFixture();
    const corrupt = { ...anchor, versionId: 'bad' };
    expect(rankPracticeCandidates(version, corrupt, [variant], [occurrence])).toEqual([]);
    const variants = [makeVariant({ id: 'b' }), makeVariant({ id: 'a' })];
    expect(
      rankPracticeCandidates(version, anchor, variants).map((result) => result.variantId),
    ).toEqual(['a', 'b']);
  });
});

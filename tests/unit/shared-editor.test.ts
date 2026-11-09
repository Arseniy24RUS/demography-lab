import { describe, expect, it } from 'vitest';
import { editedSharedBundle } from '../../apps/web/src/components/session/SharedPracticeEditModal';
import type { SharedPracticeBundle } from '../../packages/collaboration/types';

function fixture(): SharedPracticeBundle {
  return {
    schemaVersion: 1,
    practice: {
      id: 'practice-fixture',
      familyId: 'family-fixture',
      regionId: 'fixture',
      title: 'Учебная практика',
      mechanism: 'Компенсация подтверждённых расходов.',
      eligibility: 'Получатели из исходного документа.',
      amount: '10 условных единиц',
      conditions: ['При подтверждении расходов.'],
      occurrenceIds: ['quote-fixture'],
      reviewStatus: 'verified',
      evidence: [
        {
          kind: 'fragment',
          field: 'amount',
          occurrenceId: 'quote-fixture',
          relation: 'supports',
          reviewStatus: 'verified',
          reviewedValue: '10 условных единиц',
          note: 'Авторское сопоставление суммы.',
        },
        {
          kind: 'fragment',
          field: 'mechanism',
          occurrenceId: 'quote-fixture',
          relation: 'supports',
          reviewStatus: 'verified',
          reviewedValue: 'Компенсация подтверждённых расходов.',
        },
        {
          kind: 'fragment',
          field: 'eligibility',
          occurrenceId: 'quote-fixture',
          relation: 'partial',
          reviewStatus: 'verified',
          reviewedValue: 'Получатели из исходного документа.',
        },
        {
          kind: 'document',
          field: 'conditions',
          documentId: 'document-fixture',
          versionId: 'version-fixture',
        },
      ],
    },
    occurrences: [
      {
        id: 'quote-fixture',
        documentId: 'document-fixture',
        versionId: 'version-fixture',
        reviewStatus: 'verified',
        anchor: {
          id: 'anchor-fixture',
          documentId: 'document-fixture',
          versionId: 'version-fixture',
          normalizationVersion: 'unicode-nfc-lf-v1',
          spans: [
            {
              blockId: 'block-fixture',
              start: 0,
              end: 18,
              exact: '10 условных единиц',
              prefix: '',
              suffix: '',
            },
          ],
        },
      },
    ],
    sources: [
      {
        sourceId: 'document-fixture',
        editionId: 'version-fixture',
        title: 'Учебный источник',
        normalizationVersion: 'unicode-nfc-lf-v1',
      },
    ],
    note: 'Первоначальный комментарий.',
  };
}

function draftFrom(base: SharedPracticeBundle) {
  return {
    title: base.practice.title,
    mechanism: base.practice.mechanism,
    eligibility: base.practice.eligibility ?? '',
    amount: base.practice.amount ?? '',
    conditions: (base.practice.conditions ?? []).join('\n'),
    note: base.note,
  };
}

function freezeDeep(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.values(value).forEach(freezeDeep);
  Object.freeze(value);
}

describe('shared editor preserves the field → reviewed value → quote boundary', () => {
  it('invalidates only the changed amount and leaves the captured base and exact source unchanged', () => {
    const base = fixture();
    const captured = structuredClone(base);
    freezeDeep(base);
    const next = editedSharedBundle(base, { ...draftFrom(base), amount: '20 условных единиц' });

    expect(next.practice.amount).toBe('20 условных единиц');
    expect(next.practice.reviewStatus).toBe('candidate');
    expect(next.practice.evidence?.[0]).toEqual({
      kind: 'fragment',
      field: 'amount',
      occurrenceId: 'quote-fixture',
      relation: 'supports',
      reviewStatus: 'candidate',
      note: 'Авторское сопоставление суммы.',
    });
    expect(next.practice.evidence?.slice(1)).toEqual(captured.practice.evidence?.slice(1));
    expect(next.occurrences).toEqual(captured.occurrences);
    expect(next.sources).toEqual(captured.sources);
    expect(base).toEqual(captured);
  });

  it('keeps documentary verification when only the public discussion note changes', () => {
    const base = fixture();
    freezeDeep(base);
    const next = editedSharedBundle(base, {
      ...draftFrom(base),
      note: 'Уточнение для обсуждения.',
    });

    expect(next.note).toBe('Уточнение для обсуждения.');
    expect(next.practice).toEqual(base.practice);
    expect(next.occurrences).toEqual(base.occurrences);
    expect(base.note).toBe('Первоначальный комментарий.');
  });
});

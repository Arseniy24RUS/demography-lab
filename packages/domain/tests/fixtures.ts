import { NORMALIZATION_VERSION, type DocumentVersion, type PracticeVariant } from '../index';

export function makeVersion(
  texts: readonly string[] = [
    'Многодетным семьям предоставляется земельный участок.',
    'Компенсация составляет 100 000 рублей.',
  ],
): DocumentVersion {
  return {
    id: 'edition-2026',
    documentId: 'programme-13',
    normalizationVersion: NORMALIZATION_VERSION,
    blocks: texts.map((text, order) => ({
      id: `b${order}`,
      order,
      kind: 'paragraph',
      text,
      pageStart: order + 1,
    })),
  };
}

export function makeVariant(overrides: Partial<PracticeVariant> = {}): PracticeVariant {
  return {
    id: 'variant-13-land',
    familyId: 'land',
    regionId: '13',
    title: 'Земельный участок',
    mechanism: 'Предоставление земельного участка',
    eligibility: 'Многодетные семьи',
    amount: '100 000 рублей',
    conditions: ['Постоянное проживание в регионе'],
    occurrenceIds: [],
    evidence: [],
    reviewStatus: 'candidate',
    ...overrides,
  };
}

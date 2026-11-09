import { describe, expect, it } from 'vitest';
import {
  createAnchor,
  evaluateFieldEvidence,
  NORMALIZATION_VERSION,
  POPPLER_NORMALIZATION_VERSION,
  type PracticeOccurrence,
  type PracticeVariant,
} from '@domain/index';
import {
  annotationId,
  emptyReview,
  ensureAnnotation,
  localOccurrences,
  saveLink,
  validateWorkspaceAnchors,
  withLocalEvidence,
} from '@/lib/workspace-domain';
import type { CorpusDocument } from '@/lib/corpus';
import {
  createEmptyWorkspace,
  exportWorkspace,
  validateWorkspaceImport,
  validateWorkspaceState,
} from '@/storage';

const date = '2026-11-08T13:00:00.000Z';

function documentFixture(versionId = 'edition-1'): CorpusDocument {
  return {
    entry: {
      id: 'document-1',
      regionId: 'ru-13',
      title: 'Программа поддержки семьи',
      territory: 'Мордовия',
      status: 'available',
      pageCount: 1,
      versionId,
      source: { sourceUrl: 'https://example.test/programme.pdf', sha256: 'a'.repeat(64) },
    },
    version: {
      id: versionId,
      documentId: 'document-1',
      normalizationVersion: NORMALIZATION_VERSION,
      sourceSha256: 'a'.repeat(64),
      sourceUrl: 'https://example.test/programme.pdf',
      blocks: [
        {
          id: 'grant',
          order: 0,
          kind: 'paragraph',
          pageStart: 1,
          text: 'Единовременная выплата: 100 000 рублей семьям при соблюдении условий программы.',
        },
        {
          id: 'consultation',
          order: 1,
          kind: 'paragraph',
          pageStart: 1,
          text: 'Учреждение проводит консультации по выбору образовательной программы.',
        },
        {
          id: 'conditions',
          order: 2,
          kind: 'paragraph',
          pageStart: 1,
          text: 'Условия: проживание в регионе. Заявительный порядок обращения.',
        },
      ],
    },
  };
}

function variantFixture(): PracticeVariant {
  return {
    id: 'variant-1',
    familyId: 'family-1',
    regionId: 'ru-13',
    title: 'Единовременная выплата',
    mechanism: 'Денежная выплата',
    eligibility: 'Семьи, соответствующие условиям программы',
    amount: '100 000 рублей',
    conditions: ['Проживание в регионе', 'Заявительный порядок'],
    occurrenceIds: [],
  };
}

function amountAnchor(doc: CorpusDocument) {
  const text = doc.version.blocks[0].text;
  return createAnchor(doc.version, [{ blockId: 'grant', start: 0, end: Array.from(text).length }]);
}

function conditionsAnchor(doc: CorpusDocument) {
  return createAnchor(doc.version, [
    { blockId: 'conditions', start: 0, end: Array.from(doc.version.blocks[2].text).length },
  ]);
}

function unrelatedAnchor(doc: CorpusDocument) {
  return createAnchor(doc.version, [
    { blockId: 'consultation', start: 0, end: Array.from(doc.version.blocks[1].text).length },
  ]);
}

describe('workspace decisions preserve the specific source, field and reviewed value', () => {
  it('persists an explicit amount/conditions review and does not certify unreviewed fields', () => {
    const state = createEmptyWorkspace();
    const doc = documentFixture();
    const variant = variantFixture();
    const anchor = createAnchor(doc.version, [
      { blockId: 'grant', start: 0, end: Array.from(doc.version.blocks[0].text).length },
      { blockId: 'conditions', start: 0, end: Array.from(doc.version.blocks[2].text).length },
    ]);
    const link = saveLink(
      state,
      doc,
      anchor,
      variant,
      { ...emptyReview, amount: 'supports', conditions: 'supports' },
      'Проверены размер выплаты и условия.',
    );
    expect(link.fieldEvidence).toEqual([
      expect.objectContaining({
        kind: 'fragment',
        field: 'amount',
        occurrenceId: annotationId(anchor),
        reviewStatus: 'verified',
        reviewedValue: '100 000 рублей',
      }),
      expect.objectContaining({
        kind: 'fragment',
        field: 'conditions',
        occurrenceId: annotationId(anchor),
        reviewStatus: 'verified',
        reviewedValue: 'Проживание в регионе\nЗаявительный порядок',
      }),
    ]);
    expect(validateWorkspaceState(state).linkDecisions[0].fieldEvidence).toEqual(
      link.fieldEvidence,
    );
    const augmented = withLocalEvidence(variant, state);
    const context = { versions: [doc.version], occurrences: localOccurrences(state) };
    expect(evaluateFieldEvidence(augmented, 'amount', context).status).toBe('supported');
    expect(evaluateFieldEvidence(augmented, 'conditions', context).status).toBe('supported');
    expect(evaluateFieldEvidence(augmented, 'eligibility', context).status).toBe('unsupported');
  });

  it('invalidates earlier amount evidence when the card amount changes', () => {
    const state = createEmptyWorkspace();
    const doc = documentFixture();
    const variant = variantFixture();
    saveLink(
      state,
      doc,
      amountAnchor(doc),
      variant,
      { ...emptyReview, amount: 'supports' },
      'Сумма проверена по источнику.',
    );
    const changed = withLocalEvidence({ ...variant, amount: '200 000 рублей' }, state);
    const assessment = evaluateFieldEvidence(changed, 'amount', {
      versions: [doc.version],
      occurrences: localOccurrences(state),
    });
    expect(assessment.status).toBe('partial');
    expect(assessment.issues.some((issue) => issue.code === 'field_value_not_reviewed')).toBe(true);
    const originalReview = state.linkDecisions[0].fieldEvidence[0];
    expect(originalReview).toMatchObject({ reviewedValue: '100 000 рублей' });
  });

  it('updates a repeat link without duplicating the source, annotation, reading task or decision', () => {
    const state = createEmptyWorkspace();
    const doc = documentFixture();
    const variant = variantFixture();
    const anchor = amountAnchor(doc);
    const first = saveLink(
      state,
      doc,
      anchor,
      variant,
      { ...emptyReview, amount: 'supports' },
      'Первичная проверка.',
    );
    const repeated = saveLink(
      state,
      doc,
      anchor,
      variant,
      { ...emptyReview, amount: 'contradicts' },
      'Обнаружено несоответствие размера выплаты.',
    );
    expect(repeated.id).toBe(first.id);
    expect(state.sourceReferences).toHaveLength(1);
    expect(state.annotations).toHaveLength(1);
    expect(state.readingTasks).toHaveLength(1);
    expect(state.readingTasks[0]).toMatchObject({
      status: 'fragment-reviewed',
      annotationIds: [annotationId(anchor)],
      reviewedBlockIds: ['grant'],
    });
    expect(state.linkDecisions).toHaveLength(1);
    expect(state.linkDecisions[0]).toMatchObject({
      status: 'contradicted',
      fieldEvidence: [{ relation: 'contradicts' }],
    });
    expect(validateWorkspaceState(state).linkDecisions).toHaveLength(1);
  });

  it('keeps two regional variants distinct even when they refer to the same source fragment', () => {
    const state = createEmptyWorkspace();
    const doc = documentFixture();
    const variant = variantFixture();
    saveLink(
      state,
      doc,
      amountAnchor(doc),
      variant,
      { ...emptyReview, amount: 'supports' },
      'Проверено.',
    );
    saveLink(
      state,
      doc,
      amountAnchor(doc),
      { ...variant, id: 'variant-2', amount: '200 000 рублей' },
      { ...emptyReview, amount: 'contradicts' },
      'Сумма отличается от источника.',
    );
    expect(state.annotations).toHaveLength(1);
    expect(state.linkDecisions).toHaveLength(2);
    expect(withLocalEvidence(variant, state).evidence).toHaveLength(1);
    expect(withLocalEvidence({ ...variant, id: 'variant-2' }, state).evidence).toHaveLength(1);
  });

  it('rejects an anchor from another immutable edition without changing the workspace', () => {
    const old = documentFixture('edition-old');
    const current = documentFixture('edition-current');
    const state = createEmptyWorkspace();
    const before = structuredClone(state);
    expect(() =>
      saveLink(
        state,
        current,
        amountAnchor(old),
        variantFixture(),
        { ...emptyReview, amount: 'supports' },
        'Проверено.',
      ),
    ).toThrow();
    expect(state).toEqual(before);
  });

  it('rejects an empty review without leaving an annotation or a reviewed-reading flag', () => {
    const state = createEmptyWorkspace();
    const before = structuredClone(state);
    const doc = documentFixture();
    expect(() =>
      saveLink(state, doc, amountAnchor(doc), variantFixture(), { ...emptyReview }, ''),
    ).toThrow();
    expect(state).toEqual(before);
  });

  it('does not reuse a conflicting imported annotation merely because its ID matches', () => {
    const doc = documentFixture();
    const intended = amountAnchor(doc);
    const state = createEmptyWorkspace();
    const unrelated = ensureAnnotation(state, doc, unrelatedAnchor(doc));
    const previousId = unrelated.id;
    unrelated.id = annotationId(intended);
    state.readingTasks[0].annotationIds = state.readingTasks[0].annotationIds.map((id) =>
      id === previousId ? unrelated.id : id,
    );
    const before = structuredClone(state);
    expect(() =>
      saveLink(
        state,
        doc,
        intended,
        variantFixture(),
        { ...emptyReview, amount: 'supports' },
        'Проверено по выбранной цитате.',
      ),
    ).toThrow();
    expect(state).toEqual(before);
  });

  it('retains separate reading tasks and exact citations for two editions of one document', () => {
    const state = createEmptyWorkspace();
    const old = documentFixture('edition-old');
    const current = documentFixture('edition-current');
    ensureAnnotation(state, old, amountAnchor(old));
    ensureAnnotation(state, current, amountAnchor(current));
    expect(state.annotations.map((annotation) => annotation.anchor.versionId).sort()).toEqual([
      'edition-current',
      'edition-old',
    ]);
    expect(new Set(state.readingTasks.map((task) => task.id)).size).toBe(2);
    expect(state.readingTasks.map((task) => task.sourceEditionId).sort()).toEqual([
      'edition-current',
      'edition-old',
    ]);
    expect(validateWorkspaceState(state).sourceReferences).toHaveLength(2);
  });

  it('records a completed local partial review without asserting full support', () => {
    const state = createEmptyWorkspace();
    const doc = documentFixture();
    const variant = variantFixture();
    const decision = saveLink(
      state,
      doc,
      amountAnchor(doc),
      variant,
      { ...emptyReview, amount: 'partial' },
      'Цитата раскрывает только часть расчёта размера выплаты.',
    );
    expect(decision.status).toBe('candidate');
    expect(localOccurrences(state)[0].reviewStatus).toBe('verified');
    expect(
      evaluateFieldEvidence(withLocalEvidence(variant, state), 'amount', {
        versions: [doc.version],
        occurrences: localOccurrences(state),
      }).status,
    ).toBe('partial');
  });

  it('keeps unsupported/missing edition validation visible instead of assigning a different edition', () => {
    const state = createEmptyWorkspace();
    const doc = documentFixture();
    ensureAnnotation(state, doc, amountAnchor(doc));
    const missing = validateWorkspaceAnchors(state, new Map());
    expect(missing[0].validation).toBeNull();
    const wrong = validateWorkspaceAnchors(
      state,
      new Map([[doc.version.id, documentFixture('different-edition').version]]),
    );
    expect(wrong[0].validation?.valid).toBe(false);
    expect(state.annotations[0].anchor.versionId).toBe(doc.version.id);
  });
});

describe('imported assertions cannot borrow local or catalogue verification', () => {
  it('requires an explicit local field review after an unsigned export/import', () => {
    const original = createEmptyWorkspace();
    const doc = documentFixture();
    const variant = variantFixture();
    const anchor = amountAnchor(doc);
    saveLink(
      original,
      doc,
      anchor,
      variant,
      { ...emptyReview, amount: 'supports' },
      'Проверено в исходной тетради.',
    );
    const imported = validateWorkspaceImport(
      exportWorkspace({ state: original, revision: 3, updatedAt: date }),
    ).workspace;
    expect(imported.linkDecisions[0]).toMatchObject({
      origin: 'imported',
      status: 'candidate',
      importedStatus: 'verified',
    });
    expect(localOccurrences(imported)[0].reviewStatus).toBe('candidate');
    const beforeReview = evaluateFieldEvidence(withLocalEvidence(variant, imported), 'amount', {
      versions: [doc.version],
      occurrences: localOccurrences(imported),
    });
    expect(beforeReview.status).not.toBe('supported');
    saveLink(
      imported,
      doc,
      anchor,
      variant,
      { ...emptyReview, amount: 'supports' },
      'Проверено повторно по загруженной редакции.',
    );
    const afterReview = evaluateFieldEvidence(withLocalEvidence(variant, imported), 'amount', {
      versions: [doc.version],
      occurrences: localOccurrences(imported),
    });
    expect(afterReview.status).toBe('supported');
    expect(imported.linkDecisions).toHaveLength(1);
    expect(imported.linkDecisions[0].origin).toBe('local');
  });

  it('does not elevate an imported quote that collides with a verified catalogue occurrence ID', () => {
    const doc = documentFixture();
    const catalogueOccurrence: PracticeOccurrence = {
      id: 'catalogue-occurrence',
      documentId: doc.version.documentId,
      versionId: doc.version.id,
      anchor: amountAnchor(doc),
      reviewStatus: 'verified',
    };
    const variant: PracticeVariant = {
      ...variantFixture(),
      occurrenceIds: [catalogueOccurrence.id],
      evidence: [
        {
          kind: 'fragment',
          field: 'amount',
          occurrenceId: catalogueOccurrence.id,
          relation: 'supports',
          reviewStatus: 'verified',
          reviewedValue: '100 000 рублей',
        },
      ],
    };
    expect(
      evaluateFieldEvidence(variant, 'amount', {
        versions: [doc.version],
        occurrences: [catalogueOccurrence],
      }).status,
    ).toBe('supported');
    const maliciousSource = createEmptyWorkspace();
    const annotation = ensureAnnotation(maliciousSource, doc, unrelatedAnchor(doc));
    const previousId = annotation.id;
    annotation.id = catalogueOccurrence.id;
    maliciousSource.readingTasks[0].annotationIds =
      maliciousSource.readingTasks[0].annotationIds.map((id) =>
        id === previousId ? annotation.id : id,
      );
    const imported = validateWorkspaceImport(
      exportWorkspace({ state: maliciousSource, revision: 1, updatedAt: date }),
    ).workspace;
    const context = {
      versions: [doc.version],
      occurrences: [catalogueOccurrence, ...localOccurrences(imported)],
    };
    const assessed = evaluateFieldEvidence(withLocalEvidence(variant, imported), 'amount', context);
    expect(assessed.status).not.toBe('supported');
    expect(localOccurrences(imported)[0].anchor.spans[0].exact).toContain('консультации');
  });

  it('does not treat a quotation saved without a field review as reviewed evidence', () => {
    const state = createEmptyWorkspace();
    const doc = documentFixture();
    ensureAnnotation(state, doc, conditionsAnchor(doc));
    expect(localOccurrences(state)[0].reviewStatus).toBe('candidate');
    expect(state.linkDecisions).toEqual([]);
  });
});

describe('domain and persistence adapters agree', () => {
  it('accepts the corpus Poppler normalization and conditions field without relabeling the edition', () => {
    const state = createEmptyWorkspace();
    const initial = documentFixture();
    const doc: CorpusDocument = {
      ...initial,
      version: { ...initial.version, normalizationVersion: POPPLER_NORMALIZATION_VERSION },
    };
    saveLink(
      state,
      doc,
      conditionsAnchor(doc),
      variantFixture(),
      { ...emptyReview, conditions: 'supports' },
      'Условия сопоставлены с источником.',
    );
    const validated = validateWorkspaceState(state);
    expect(validated.annotations[0].anchor.normalizationVersion).toBe(
      POPPLER_NORMALIZATION_VERSION,
    );
    expect(validated.linkDecisions[0].fieldEvidence[0]).toMatchObject({
      field: 'conditions',
      reviewedValue: 'Проживание в регионе\nЗаявительный порядок',
    });
  });

  it('accepts an explicit field confirmation without an optional prose rationale', () => {
    const state = createEmptyWorkspace();
    const doc = documentFixture();
    saveLink(
      state,
      doc,
      amountAnchor(doc),
      variantFixture(),
      { ...emptyReview, amount: 'supports' },
      '',
    );
    expect(validateWorkspaceState(state).linkDecisions[0]).toMatchObject({
      status: 'verified',
      rationale: '',
    });
    const noField = structuredClone(state);
    noField.linkDecisions[0].fieldEvidence = [];
    expect(() => validateWorkspaceState(noField)).toThrow();
  });

  it('can retain a source whose optional URL and digest are unknown without inventing either', () => {
    const initial = documentFixture();
    const { sourceSha256: _digest, sourceUrl: _url, ...version } = initial.version;
    const doc: CorpusDocument = { ...initial, entry: { ...initial.entry, source: {} }, version };
    const state = createEmptyWorkspace();
    ensureAnnotation(state, doc, amountAnchor(doc));
    const validated = validateWorkspaceState(state);
    expect(validated.sourceReferences[0]).not.toHaveProperty('sha256');
    expect(validated.sourceReferences[0]).not.toHaveProperty('sourceUrl');
  });
});

describe('incremental verification of a source link', () => {
  it('keeps previously reviewed fields when the next check adds another field', () => {
    const state = createEmptyWorkspace();
    const doc = documentFixture();
    const v = variantFixture();
    const a = amountAnchor(doc);
    saveLink(state, doc, a, v, { ...emptyReview, amount: 'supports' }, 'Сумма проверена.');
    saveLink(state, doc, a, v, { ...emptyReview, mechanism: 'supports' }, 'Механизм проверен.');
    expect(state.linkDecisions).toHaveLength(1);
    expect(state.linkDecisions[0].fieldEvidence).toHaveLength(2);
    const reviewed = withLocalEvidence(v, state);
    const context = { versions: [doc.version], occurrences: localOccurrences(state) };
    expect(evaluateFieldEvidence(reviewed, 'amount', context).status).toBe('supported');
    expect(evaluateFieldEvidence(reviewed, 'mechanism', context).status).toBe('supported');
    expect(evaluateFieldEvidence(reviewed, 'eligibility', context).status).toBe('unsupported');
    expect(validateWorkspaceState(state).linkDecisions[0].fieldEvidence).toHaveLength(2);
  });
});

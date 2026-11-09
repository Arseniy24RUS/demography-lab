import { stableId, validateAnchor } from '@domain/index';
import type {
  DocumentVersion,
  TextAnchor,
  PracticeOccurrence,
  PracticeVariant,
  FieldEvidence,
  PracticeField,
  EvidenceRelation,
} from '@domain/index';
import type { WorkspaceState, WorkspaceAnnotation, SourceReference, LinkDecision } from '@/storage';
import type { CorpusDocument } from './corpus';

export const fieldLabels: Record<PracticeField, string> = {
  title: 'Название',
  mechanism: 'Механизм',
  eligibility: 'Получатели',
  amount: 'Размер и объём',
  conditions: 'Условия',
};
export type FieldReview = Record<PracticeField, 'none' | EvidenceRelation>;
export const emptyReview: FieldReview = {
  title: 'none',
  mechanism: 'none',
  eligibility: 'none',
  amount: 'none',
  conditions: 'none',
};
export function fieldValue(variant: PracticeVariant, field: PracticeField) {
  return field === 'conditions'
    ? (variant.conditions ?? []).join('\n')
    : String(variant[field] ?? '');
}
export function anchorQuote(anchor: TextAnchor) {
  return anchor.spans.map((s) => s.exact).join('\n\n');
}
export function sourceReference(doc: CorpusDocument): SourceReference {
  const url = doc.version.sourceUrl ?? doc.entry.source.sourceUrl;
  return {
    sourceId: doc.entry.id,
    editionId: doc.version.id,
    title: doc.entry.title,
    ...(doc.version.sourceSha256 ? { sha256: doc.version.sourceSha256 } : {}),
    normalizationVersion: doc.version.normalizationVersion,
    ...(url ? { sourceUrl: url } : {}),
    regionId: doc.entry.regionId,
  };
}
export function annotationId(anchor: TextAnchor) {
  return `annotation-${anchor.id}`;
}
export function ensureAnnotation(
  state: WorkspaceState,
  doc: CorpusDocument,
  anchor: TextAnchor,
  note = '',
): WorkspaceAnnotation {
  const checked = validateAnchor(doc.version, anchor);
  if (!checked.valid)
    throw new Error(`Цитата не прошла проверку: ${checked.issues[0]?.message ?? 'ошибка якоря'}`);
  const now = new Date().toISOString();
  const id = annotationId(anchor);
  let annotation = state.annotations.find((a) => a.id === id);
  if (annotation) {
    const a = annotation.anchor;
    const equal =
      a.documentId === anchor.documentId &&
      a.versionId === anchor.versionId &&
      a.normalizationVersion === anchor.normalizationVersion &&
      a.spans.length === anchor.spans.length &&
      a.spans.every((span, i) => {
        const other = anchor.spans[i];
        return (
          span.blockId === other.blockId &&
          span.start === other.start &&
          span.end === other.end &&
          span.exact === other.exact &&
          span.prefix === other.prefix &&
          span.suffix === other.suffix
        );
      });
    if (!equal)
      throw new Error('Идентификатор цитаты уже связан с другим фрагментом. Сохранение отменено.');
  }
  if (!state.sourceReferences.some((s) => s.editionId === doc.version.id))
    state.sourceReferences.push(sourceReference(doc));
  if (!annotation) {
    annotation = { id, anchor, note, createdAt: now, updatedAt: now };
    state.annotations.push(annotation);
  } else if (note) {
    annotation.note = note;
    annotation.updatedAt = now;
  }
  const task = state.readingTasks.find((t) => t.sourceEditionId === doc.version.id);
  if (task) {
    task.status = 'fragment-reviewed';
    task.reviewedBlockIds = [
      ...new Set([...task.reviewedBlockIds, ...anchor.spans.map((s) => s.blockId)]),
    ];
    task.annotationIds = [...new Set([...task.annotationIds, id])];
    task.updatedAt = now;
  } else
    state.readingTasks.push({
      id: stableId('reading', doc.entry.id, doc.version.id),
      sourceEditionId: doc.version.id,
      status: 'fragment-reviewed',
      reviewedBlockIds: anchor.spans.map((s) => s.blockId),
      annotationIds: [id],
      note: 'Проверены выбранные фрагменты. Полная экспертиза документа не заявляется.',
      updatedAt: now,
    });
  return annotation;
}
export function localOccurrences(state: WorkspaceState): PracticeOccurrence[] {
  return state.annotations.map((a) => ({
    id: a.id,
    documentId: a.anchor.documentId,
    versionId: a.anchor.versionId,
    anchor: a.anchor,
    reviewStatus: state.linkDecisions.some(
      (l) =>
        l.origin === 'local' &&
        l.annotationId === a.id &&
        l.fieldEvidence.some(
          (e) => e.kind === 'fragment' && e.occurrenceId === a.id && e.reviewStatus === 'verified',
        ),
    )
      ? 'verified'
      : 'candidate',
    note: a.note,
  }));
}
export function withLocalEvidence<T extends PracticeVariant>(variant: T, state: WorkspaceState): T {
  const links = state.linkDecisions.filter((l) => l.practiceId === variant.id);
  return {
    ...variant,
    occurrenceIds: [
      ...new Set([
        ...variant.occurrenceIds,
        ...links.flatMap((l) => (l.annotationId ? [l.annotationId] : [])),
      ]),
    ],
    evidence: [...(variant.evidence ?? []), ...links.flatMap((l) => l.fieldEvidence)],
  };
}
export function saveLink(
  state: WorkspaceState,
  doc: CorpusDocument,
  anchor: TextAnchor,
  variant: PracticeVariant,
  review: FieldReview,
  rationale: string,
): LinkDecision {
  if (variant.regionId !== doc.entry.regionId)
    throw new Error(
      'Карточка и документ относятся к разным регионам. Создайте самостоятельный региональный вариант.',
    );
  const fields = (Object.keys(review) as PracticeField[]).filter(
    (f) => review[f] !== 'none' && fieldValue(variant, f),
  );
  if (!fields.length) throw new Error('Укажите, какое поле подтверждает или опровергает цитата.');
  if (fields.some((f) => !['supports', 'partial', 'contradicts'].includes(review[f])))
    throw new Error('Неизвестный результат проверки поля.');
  if (fields.some((f) => review[f] === 'contradicts') && rationale.trim().length < 5)
    throw new Error('Объясните выявленное противоречие.');
  const annotation = ensureAnnotation(state, doc, anchor);
  const id = stableId('link', `${annotation.id}|${variant.id}`);
  const index = state.linkDecisions.findIndex((l) => l.id === id);
  const prior =
    index >= 0
      ? state.linkDecisions[index].fieldEvidence.filter(
          (e) => !e.field || !fields.includes(e.field),
        )
      : [];
  const fieldEvidence: FieldEvidence[] = [
    ...prior,
    ...fields.map<FieldEvidence>((field) => ({
      kind: 'fragment',
      field,
      occurrenceId: annotation.id,
      relation: review[field] as EvidenceRelation,
      reviewStatus: 'verified',
      reviewedValue: fieldValue(variant, field),
      note: rationale.trim(),
    })),
  ];
  const decision: LinkDecision = {
    id,
    annotationId: annotation.id,
    practiceId: variant.id,
    status: fieldEvidence.some((e) => e.kind === 'fragment' && e.relation === 'contradicts')
      ? 'contradicted'
      : fieldEvidence.every(
            (e) =>
              e.kind === 'fragment' && e.relation === 'supports' && e.reviewStatus === 'verified',
          )
        ? 'verified'
        : 'candidate',
    rationale: rationale.trim(),
    decidedAt: new Date().toISOString(),
    origin: 'local',
    fieldEvidence,
  };
  if (index < 0) state.linkDecisions.push(decision);
  else state.linkDecisions[index] = decision;
  return decision;
}
export function validateWorkspaceAnchors(
  state: WorkspaceState,
  versions: ReadonlyMap<string, DocumentVersion>,
) {
  return state.annotations.map((a) => ({
    annotation: a,
    validation: versions.has(a.anchor.versionId)
      ? validateAnchor(versions.get(a.anchor.versionId)!, a.anchor)
      : null,
  }));
}

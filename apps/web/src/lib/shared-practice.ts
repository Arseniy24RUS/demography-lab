import { validateAnchor } from '@domain/index';
import type { PracticeOccurrence, PracticeVariant } from '@domain/index';
import { parseBundle } from '../../../../packages/collaboration/schema';
import type {
  SharedPracticeBundle,
  SharedSourceReference,
} from '../../../../packages/collaboration/types';
import { loadDocument, type CorpusManifest } from './corpus';

/** Explicit projection prevents private profile/reader state and source metadata from leaking. */
export async function prepareSharedPractice(
  practice: PracticeVariant,
  allOccurrences: readonly PracticeOccurrence[],
  manifest: CorpusManifest,
  note = '',
): Promise<SharedPracticeBundle> {
  const byId = new Map(allOccurrences.map((o) => [o.id, o]));
  const occurrences = practice.occurrenceIds.map((id) => {
    const o = byId.get(id);
    if (!o)
      throw new Error('Не найден фрагмент карточки. Сначала проверьте её текстовые основания.');
    return {
      id: o.id,
      documentId: o.documentId,
      versionId: o.versionId,
      anchor: structuredClone(o.anchor),
      reviewStatus: o.reviewStatus,
      ...(o.note !== undefined ? { note: o.note } : {}),
    };
  });
  if (!occurrences.length)
    throw new Error(
      'Для общей доски сначала свяжите карточку хотя бы с одним точным фрагментом программы.',
    );
  const sourceVersions = new Map(occurrences.map((o) => [o.versionId, o.documentId]));
  for (const e of practice.evidence ?? [])
    if (e.kind === 'document') sourceVersions.set(e.versionId, e.documentId);
  const sources: SharedSourceReference[] = [];
  for (const [versionId, documentId] of sourceVersions) {
    const entry = manifest.documents.find((d) => d.id === documentId);
    if (!entry) throw new Error('Документ карточки отсутствует в текущем корпусе.');
    const material = await loadDocument(entry);
    if (material.version.id !== versionId)
      throw new Error('Сохранённая цитата относится к другой редакции документа.');
    for (const o of occurrences.filter((o) => o.versionId === versionId))
      if (!validateAnchor(material.version, o.anchor).valid)
        throw new Error(
          'Цитата не совпала с текстом документа. Исправьте привязку перед публикацией.',
        );
    sources.push({
      sourceId: documentId,
      editionId: versionId,
      title: entry.title,
      normalizationVersion: material.version.normalizationVersion,
      regionId: entry.regionId,
      ...(material.version.sourceSha256 ? { sha256: material.version.sourceSha256 } : {}),
      ...(material.version.sourceUrl ? { sourceUrl: material.version.sourceUrl } : {}),
    });
  }
  // Copy only the domain contract; catalogue metadata and local draft timestamps stay local.
  const clean: PracticeVariant = {
    id: practice.id,
    familyId: practice.familyId,
    regionId: practice.regionId,
    title: practice.title,
    mechanism: practice.mechanism,
    ...(practice.eligibility !== undefined ? { eligibility: practice.eligibility } : {}),
    ...(practice.amount !== undefined ? { amount: practice.amount } : {}),
    ...(practice.conditions ? { conditions: [...practice.conditions] } : {}),
    occurrenceIds: [...practice.occurrenceIds],
    ...(practice.evidence ? { evidence: structuredClone(practice.evidence) } : {}),
    ...(practice.reviewStatus ? { reviewStatus: practice.reviewStatus } : {}),
  };
  return parseBundle({ schemaVersion: 1, practice: clean, occurrences, sources, note });
}

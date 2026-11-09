import { DomainValidationError } from './anchors';
import { validateDocumentVersion } from './corpus';
import {
  NORMALIZATION_VERSIONS,
  type DocumentBlock,
  type DocumentPage,
  type DocumentVersion,
  type NormalizationVersion,
} from './types';
import { isNonEmptyString, isRecord } from './unicode';

const KINDS = new Set([
  'heading',
  'paragraph',
  'list-item',
  'table-cell',
  'table-row',
  'caption',
  'other',
]);

/**
 * Adapter for the repository's extracted corpus JSON (flat or metadata/content form).
 * Canonical text is never edited here: doing so would invalidate stored hashes/anchors.
 * No incoming position selectors are converted or accepted by this adapter.
 */
export function toDocumentVersion(input: unknown): DocumentVersion {
  const direct = validateDocumentVersion(input);
  if (direct.valid) return direct.value;
  const invalid = (message: string): never => {
    throw new DomainValidationError(message, [
      { code: 'invalid_corpus_adapter_input', path: '', message },
    ]);
  };
  if (!isRecord(input)) return invalid('Extracted corpus document must be an object.');
  if (isRecord(input.version)) {
    const nested = validateDocumentVersion(input.version);
    if (!nested.valid)
      throw new DomainValidationError('Invalid nested document edition.', nested.issues);
    if (isRecord(input.meta) && input.meta.id !== nested.value.documentId)
      return invalid('Document metadata and edition identity disagree.');
    return nested.value;
  }
  const metadata = isRecord(input.metadata) ? input.metadata : input;
  const content = isRecord(input.content) ? input.content : input;
  const extraction = isRecord(input.extraction) ? input.extraction : {};
  const source = isRecord(metadata.source) ? metadata.source : {};
  const versionId = metadata.versionId;
  const documentId = metadata.documentId ?? metadata.id;
  if (!isNonEmptyString(versionId) || !isNonEmptyString(documentId))
    return invalid('Document ID and immutable version ID are required.');
  const normalization = metadata.normalizationVersion ?? extraction.canonicalization;
  if (typeof normalization !== 'string' || !NORMALIZATION_VERSIONS.includes(normalization))
    return invalid('The extraction must declare a supported canonical normalization version.');
  if (!Array.isArray(content.blocks)) return invalid('Extracted document has no blocks array.');
  const blocks: DocumentBlock[] = content.blocks.map((raw: unknown, index: number) => {
    if (!isRecord(raw) || !isNonEmptyString(raw.id) || typeof raw.text !== 'string')
      return invalid(`Invalid block at index ${index}.`);
    const kind = raw.kind ?? raw.type ?? 'paragraph';
    const page = raw.pageStart ?? raw.pageNumber ?? raw.page;
    if (raw.documentId !== undefined && raw.documentId !== documentId)
      return invalid(`Block ${raw.id} belongs to another document.`);
    if (raw.documentVersionId !== undefined && raw.documentVersionId !== versionId)
      return invalid(`Block ${raw.id} belongs to another edition.`);
    return {
      id: raw.id,
      order: typeof raw.order === 'number' ? raw.order : index,
      kind: typeof kind === 'string' && KINDS.has(kind) ? (kind as DocumentBlock['kind']) : 'other',
      text: raw.text,
      ...(typeof page === 'number' ? { pageStart: page } : {}),
      ...(typeof raw.pageEnd === 'number' ? { pageEnd: raw.pageEnd } : {}),
    };
  });
  const pages: DocumentPage[] | undefined = Array.isArray(content.pages)
    ? content.pages.map((raw: unknown) => {
        if (!isRecord(raw) || typeof (raw.number ?? raw.pageNumber) !== 'number')
          return invalid('Invalid page identity.');
        return {
          number: (raw.number ?? raw.pageNumber) as number,
          ...(typeof raw.printedLabel === 'string' ? { printedLabel: raw.printedLabel } : {}),
        };
      })
    : undefined;
  const sha256 = metadata.sourceSha256 ?? source.sha256;
  const url = metadata.sourceUrl ?? source.sourceUrl;
  const label = metadata.editionLabel ?? source.edition;
  const version: DocumentVersion = {
    id: versionId,
    documentId,
    normalizationVersion: normalization as NormalizationVersion,
    blocks,
    ...(pages ? { pages } : {}),
    ...(typeof sha256 === 'string' ? { sourceSha256: sha256 } : {}),
    ...(typeof url === 'string' ? { sourceUrl: url } : {}),
    ...(typeof label === 'string' ? { editionLabel: label } : {}),
    ...(typeof source.originalFilename === 'string'
      ? { sourceFileName: source.originalFilename }
      : {}),
    ...(source.quality === 'partial'
      ? { completeness: 'partial' as const }
      : source.quality === 'full'
        ? { completeness: 'full' as const }
        : {}),
  };
  const result = validateDocumentVersion(version);
  if (!result.valid) throw new DomainValidationError('Invalid canonical corpus.', result.issues);
  return result.value;
}

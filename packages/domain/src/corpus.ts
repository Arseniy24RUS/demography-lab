import {
  NORMALIZATION_VERSIONS,
  type DocumentVersion,
  type ValidationIssue,
  type ValidationResult,
} from './types';
import {
  hasUnpairedSurrogate,
  isNonEmptyString,
  isRecord,
  normalizeCanonicalText,
} from './unicode';

const BLOCK_KINDS = new Set([
  'heading',
  'paragraph',
  'list-item',
  'table-cell',
  'table-row',
  'caption',
  'other',
]);

export function validateDocumentVersion(input: unknown): ValidationResult<DocumentVersion> {
  const issues: ValidationIssue[] = [];
  const fail = (code: string, path: string, message: string): void => {
    issues.push({ code, path, message });
  };
  if (!isRecord(input))
    return {
      valid: false,
      issues: [
        { code: 'invalid_document', path: '', message: 'Document version must be an object.' },
      ],
    };
  for (const key of ['id', 'documentId']) {
    if (!isNonEmptyString(input[key])) fail('missing_identity', key, `${key} is required.`);
  }
  if (
    typeof input.normalizationVersion !== 'string' ||
    !NORMALIZATION_VERSIONS.includes(input.normalizationVersion)
  )
    fail('unsupported_normalization', 'normalizationVersion', 'Unsupported normalization version.');
  if (
    input.sourceSha256 !== undefined &&
    (typeof input.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(input.sourceSha256))
  ) {
    fail(
      'invalid_source_hash',
      'sourceSha256',
      'Source hash must be a SHA-256 hexadecimal digest.',
    );
  }
  if (!Array.isArray(input.blocks) || input.blocks.length === 0) {
    fail('missing_blocks', 'blocks', 'At least one canonical block is required.');
  } else {
    const ids = new Set<string>();
    let lastOrder = -1;
    input.blocks.forEach((block: unknown, index: number) => {
      const path = `blocks[${index}]`;
      if (!isRecord(block)) {
        fail('invalid_block', path, 'Block must be an object.');
        return;
      }
      if (!isNonEmptyString(block.id))
        fail('missing_block_id', `${path}.id`, 'A stable block ID is required.');
      else if (ids.has(block.id))
        fail('duplicate_block_id', `${path}.id`, 'Block IDs must be unique within a version.');
      else ids.add(block.id);
      if (
        !Number.isSafeInteger(block.order) ||
        (block.order as number) < 0 ||
        (block.order as number) <= lastOrder
      ) {
        fail(
          'invalid_block_order',
          `${path}.order`,
          'Canonical block order must be strictly increasing nonnegative integers.',
        );
      }
      if (typeof block.order === 'number') lastOrder = block.order;
      if (typeof block.kind !== 'string' || !BLOCK_KINDS.has(block.kind))
        fail('invalid_block_kind', `${path}.kind`, 'Unsupported block kind.');
      if (typeof block.text !== 'string')
        fail('invalid_block_text', `${path}.text`, 'Text must be a string.');
      else if (
        hasUnpairedSurrogate(block.text) ||
        block.text !== normalizeCanonicalText(block.text)
      )
        fail(
          'noncanonical_text',
          `${path}.text`,
          'Text must be valid Unicode in the registered canonical normalization.',
        );
      for (const key of ['pageStart', 'pageEnd']) {
        if (
          block[key] !== undefined &&
          (!Number.isSafeInteger(block[key]) || (block[key] as number) < 1)
        )
          fail('invalid_page', `${path}.${key}`, 'Source pages are positive 1-based integers.');
      }
      if (
        typeof block.pageStart === 'number' &&
        typeof block.pageEnd === 'number' &&
        block.pageEnd < block.pageStart
      )
        fail('invalid_page_range', path, 'Page range is reversed.');
    });
  }
  if (input.pages !== undefined) {
    if (!Array.isArray(input.pages)) fail('invalid_pages', 'pages', 'Pages must be an array.');
    else {
      let previous = 0;
      input.pages.forEach((page: unknown, index: number) => {
        if (
          !isRecord(page) ||
          !Number.isSafeInteger(page.number) ||
          (page.number as number) <= previous
        )
          fail(
            'invalid_page_order',
            `pages[${index}]`,
            'Page numbers must be strictly increasing positive integers.',
          );
        else previous = page.number as number;
      });
    }
  }
  return issues.length
    ? { valid: false, issues }
    : { valid: true, value: input as unknown as DocumentVersion, issues: [] };
}

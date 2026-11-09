import { validateDocumentVersion } from './corpus';
import {
  NORMALIZATION_VERSIONS,
  type BlockSelection,
  type DocumentVersion,
  type TextAnchor,
  type TextPoint,
  type TextSpan,
  type ValidationIssue,
  type ValidationResult,
} from './types';
import {
  codePointLength,
  hasUnpairedSurrogate,
  isNonEmptyString,
  isRecord,
  sliceCodePoints,
  stableId,
} from './unicode';

export const MAX_ANCHOR_SPANS = 256;
export const DEFAULT_CONTEXT_LENGTH = 48;
export const MAX_CONTEXT_LENGTH = 256;
export const MAX_ANCHOR_QUOTE_LENGTH = 100_000;

export class DomainValidationError extends Error {
  readonly issues: readonly ValidationIssue[];
  constructor(message: string, issues: readonly ValidationIssue[]) {
    super(message);
    this.name = 'DomainValidationError';
    this.issues = issues;
  }
}

function shapeIssues(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fail = (code: string, path: string, message: string): void => {
    issues.push({ code, path, message });
  };
  if (!isRecord(input))
    return [{ code: 'invalid_anchor', path: '', message: 'Anchor must be an object.' }];
  for (const key of ['id', 'documentId', 'versionId']) {
    if (!isNonEmptyString(input[key])) fail('missing_identity', key, `${key} is required.`);
  }
  if (
    typeof input.normalizationVersion !== 'string' ||
    !NORMALIZATION_VERSIONS.includes(input.normalizationVersion)
  )
    fail('unsupported_normalization', 'normalizationVersion', 'Unsupported normalization version.');
  if (
    !Array.isArray(input.spans) ||
    input.spans.length === 0 ||
    input.spans.length > MAX_ANCHOR_SPANS
  ) {
    fail('invalid_spans', 'spans', `Anchor must have 1–${MAX_ANCHOR_SPANS} spans.`);
    return issues;
  }
  let quoteLength = 0;
  input.spans.forEach((span: unknown, index: number) => {
    const path = `spans[${index}]`;
    if (!isRecord(span)) {
      fail('invalid_span', path, 'Span must be an object.');
      return;
    }
    if (!isNonEmptyString(span.blockId))
      fail('missing_block_id', `${path}.blockId`, 'Block ID is required.');
    for (const key of ['start', 'end']) {
      if (!Number.isSafeInteger(span[key]) || (span[key] as number) < 0)
        fail('invalid_offset', `${path}.${key}`, 'Offsets must be nonnegative safe integers.');
    }
    if (typeof span.start === 'number' && typeof span.end === 'number' && span.end <= span.start)
      fail('empty_or_reversed_span', path, 'End must follow start.');
    for (const key of ['exact', 'prefix', 'suffix']) {
      const value = span[key];
      if (typeof value !== 'string' || hasUnpairedSurrogate(value))
        fail('invalid_selector_text', `${path}.${key}`, 'Selector must be valid Unicode text.');
      else if (key === 'exact') {
        quoteLength += codePointLength(value);
        if (!value.length) fail('empty_quote', `${path}.exact`, 'Exact quote cannot be empty.');
      } else if (codePointLength(value) > MAX_CONTEXT_LENGTH)
        fail('context_too_long', `${path}.${key}`, 'Selector context exceeds the accepted bound.');
    }
  });
  if (quoteLength > MAX_ANCHOR_QUOTE_LENGTH)
    fail('quote_too_long', 'spans', 'Combined quote exceeds the accepted bound.');
  return issues;
}

/** Pure runtime validator usable at the client boundary and in server commands. */
export function validateAnchor(
  version: DocumentVersion,
  input: unknown,
): ValidationResult<TextAnchor> {
  const corpus = validateDocumentVersion(version);
  if (!corpus.valid)
    return {
      valid: false,
      issues: corpus.issues.map((issue) => ({ ...issue, path: `version.${issue.path}` })),
    };
  const issues = shapeIssues(input);
  if (issues.length) return { valid: false, issues };
  const anchor = input as TextAnchor;
  if (anchor.documentId !== version.documentId)
    issues.push({
      code: 'document_mismatch',
      path: 'documentId',
      message: 'Anchor belongs to another document.',
    });
  if (anchor.versionId !== version.id)
    issues.push({
      code: 'version_mismatch',
      path: 'versionId',
      message: 'Anchor belongs to another immutable edition.',
    });
  if (anchor.normalizationVersion !== version.normalizationVersion)
    issues.push({
      code: 'normalization_mismatch',
      path: 'normalizationVersion',
      message: 'Canonical normalization differs.',
    });
  const blocks = new Map(version.blocks.map((block, index) => [block.id, { block, index }]));
  let previousIndex = -1;
  let previousEnd = -1;
  anchor.spans.forEach((span, index) => {
    const path = `spans[${index}]`;
    const entry = blocks.get(span.blockId);
    if (!entry) {
      issues.push({
        code: 'block_not_found',
        path,
        message: 'Block does not belong to this edition.',
      });
      return;
    }
    if (entry.index < previousIndex || (entry.index === previousIndex && span.start < previousEnd))
      issues.push({
        code: 'unordered_or_overlapping_spans',
        path,
        message: 'Spans must follow canonical reading order without overlap.',
      });
    previousIndex = entry.index;
    previousEnd = span.end;
    const text = Array.from(entry.block.text);
    if (span.end > text.length || span.start >= text.length) {
      issues.push({
        code: 'offset_out_of_bounds',
        path,
        message: 'Range exceeds the canonical block.',
      });
      return;
    }
    if (text.slice(span.start, span.end).join('') !== span.exact)
      issues.push({
        code: 'quote_mismatch',
        path: `${path}.exact`,
        message: 'Exact quote does not match the canonical range.',
      });
    const prefixLength = codePointLength(span.prefix);
    const suffixLength = codePointLength(span.suffix);
    if (
      prefixLength > span.start ||
      text.slice(span.start - prefixLength, span.start).join('') !== span.prefix
    )
      issues.push({
        code: 'prefix_mismatch',
        path: `${path}.prefix`,
        message: 'Prefix does not match preceding canonical text.',
      });
    if (
      span.end + suffixLength > text.length ||
      text.slice(span.end, span.end + suffixLength).join('') !== span.suffix
    )
      issues.push({
        code: 'suffix_mismatch',
        path: `${path}.suffix`,
        message: 'Suffix does not match following canonical text.',
      });
  });
  return issues.length ? { valid: false, issues } : { valid: true, value: anchor, issues: [] };
}

function anchorIdentity(version: DocumentVersion, spans: readonly TextSpan[]): string {
  return stableId(
    'anchor',
    version.documentId,
    version.id,
    version.normalizationVersion,
    JSON.stringify(spans),
  );
}

function assembleAnchor(
  version: DocumentVersion,
  selections: readonly BlockSelection[],
  contextLength: number,
): TextAnchor {
  const blocks = new Map(version.blocks.map((block) => [block.id, block]));
  const spans = selections.map((selection) => {
    const block = blocks.get(selection.blockId);
    if (!block)
      throw new DomainValidationError('Unknown block.', [
        {
          code: 'block_not_found',
          path: 'selections',
          message: 'Block does not belong to this edition.',
        },
      ]);
    const chars = Array.from(block.text);
    if (
      !Number.isSafeInteger(selection.start) ||
      !Number.isSafeInteger(selection.end) ||
      selection.start < 0 ||
      selection.end > chars.length ||
      selection.end <= selection.start
    ) {
      throw new DomainValidationError('Invalid selection.', [
        {
          code: 'invalid_offset',
          path: 'selections',
          message: 'Selection must be a nonempty code-point range inside the block.',
        },
      ]);
    }
    return {
      blockId: selection.blockId,
      start: selection.start,
      end: selection.end,
      exact: chars.slice(selection.start, selection.end).join(''),
      prefix: chars.slice(Math.max(0, selection.start - contextLength), selection.start).join(''),
      suffix: chars
        .slice(selection.end, Math.min(chars.length, selection.end + contextLength))
        .join(''),
    };
  });
  return {
    id: anchorIdentity(version, spans),
    documentId: version.documentId,
    versionId: version.id,
    normalizationVersion: version.normalizationVersion,
    spans,
  };
}

export function createAnchor(
  version: DocumentVersion,
  selections: readonly BlockSelection[],
  options: { readonly contextLength?: number } = {},
): TextAnchor {
  const corpus = validateDocumentVersion(version);
  if (!corpus.valid) throw new DomainValidationError('Invalid document version.', corpus.issues);
  const contextLength = options.contextLength ?? DEFAULT_CONTEXT_LENGTH;
  if (
    !Number.isSafeInteger(contextLength) ||
    contextLength < 0 ||
    contextLength > MAX_CONTEXT_LENGTH
  )
    throw new RangeError(`Context length must be an integer between 0 and ${MAX_CONTEXT_LENGTH}.`);
  if (selections.length === 0 || selections.length > MAX_ANCHOR_SPANS)
    throw new RangeError(`Supply 1–${MAX_ANCHOR_SPANS} ordered selections.`);
  const anchor = assembleAnchor(version, selections, contextLength);
  const result = validateAnchor(version, anchor);
  if (!result.valid) throw new DomainValidationError('Invalid anchor.', result.issues);
  return anchor;
}

/** Construct a continuous selection; empty intermediate blocks have no span. */
export function createRangeAnchor(
  version: DocumentVersion,
  from: TextPoint,
  to: TextPoint,
  options: { readonly contextLength?: number } = {},
): TextAnchor {
  const first = version.blocks.findIndex((block) => block.id === from.blockId);
  const last = version.blocks.findIndex((block) => block.id === to.blockId);
  if (first < 0 || last < 0 || last < first || (first === last && to.offset <= from.offset))
    throw new RangeError('Range endpoints must follow reading order.');
  const firstLength = codePointLength(version.blocks[first]!.text);
  const lastLength = codePointLength(version.blocks[last]!.text);
  if (
    !Number.isSafeInteger(from.offset) ||
    from.offset < 0 ||
    from.offset > firstLength ||
    !Number.isSafeInteger(to.offset) ||
    to.offset < 0 ||
    to.offset > lastLength
  )
    throw new RangeError('Range endpoint is outside its block.');
  const selections: BlockSelection[] = [];
  for (let index = first; index <= last; index += 1) {
    const block = version.blocks[index]!;
    const start = index === first ? from.offset : 0;
    const end = index === last ? to.offset : codePointLength(block.text);
    if (end > start) selections.push({ blockId: block.id, start, end });
  }
  return createAnchor(version, selections, options);
}

/** Separator is presentation only; positions are always block-local. */
export function anchorText(anchor: TextAnchor, separator = '\n\n'): string {
  return anchor.spans.map((span) => span.exact).join(separator);
}

interface LocatedSpan extends BlockSelection {
  readonly blockIndex: number;
}
interface CandidateSet {
  readonly candidates: readonly TextAnchor[];
  readonly truncated: boolean;
}

function locate(
  version: DocumentVersion,
  original: TextAnchor,
  matchContext: boolean,
  limit: number,
): CandidateSet {
  let scanTruncated = false;
  const MAX_LOCATIONS_PER_SPAN = 2_000;
  const choices = original.spans.map((span) => {
    const found: LocatedSpan[] = [];
    for (let blockIndex = 0; blockIndex < version.blocks.length; blockIndex += 1) {
      const block = version.blocks[blockIndex]!;
      let from = 0;
      while (from < block.text.length) {
        const index = block.text.indexOf(span.exact, from);
        if (index < 0) break;
        const start = codePointLength(block.text.slice(0, index));
        const end = start + codePointLength(span.exact);
        const prefixLength = codePointLength(span.prefix);
        const suffixLength = codePointLength(span.suffix);
        const size = codePointLength(block.text);
        const contextMatches =
          !matchContext ||
          (prefixLength <= start &&
            end + suffixLength <= size &&
            sliceCodePoints(block.text, start - prefixLength, start) === span.prefix &&
            sliceCodePoints(block.text, end, end + suffixLength) === span.suffix);
        if (contextMatches) found.push({ blockId: block.id, blockIndex, start, end });
        if (found.length >= MAX_LOCATIONS_PER_SPAN) {
          scanTruncated = true;
          break;
        }
        from = index + (block.text.codePointAt(index)! > 0xffff ? 2 : 1);
      }
      if (found.length >= MAX_LOCATIONS_PER_SPAN) break;
    }
    return found;
  });
  const candidates: TextAnchor[] = [];
  let pathTruncated = false;
  let examined = 0;
  const MAX_PATH_STEPS = 50_000;
  const visit = (depth: number, path: readonly LocatedSpan[]): void => {
    if (candidates.length > limit || examined > MAX_PATH_STEPS) {
      pathTruncated = true;
      return;
    }
    if (depth === choices.length) {
      candidates.push(assembleAnchor(version, path, DEFAULT_CONTEXT_LENGTH));
      return;
    }
    for (const choice of choices[depth]!) {
      examined += 1;
      const prior = path[path.length - 1];
      if (
        !prior ||
        choice.blockIndex > prior.blockIndex ||
        (choice.blockIndex === prior.blockIndex && choice.start >= prior.end)
      )
        visit(depth + 1, [...path, choice]);
      if (candidates.length > limit || examined > MAX_PATH_STEPS) {
        pathTruncated = true;
        break;
      }
    }
  };
  if (choices.every((choice) => choice.length > 0)) visit(0, []);
  return { candidates: candidates.slice(0, limit), truncated: scanTruncated || pathTruncated };
}

export type ReanchorResult =
  | { readonly status: 'unchanged'; readonly anchor: TextAnchor }
  | { readonly status: 'reanchored'; readonly anchor: TextAnchor; readonly requiresReview: true }
  | {
      readonly status: 'ambiguous';
      readonly candidates: readonly TextAnchor[];
      readonly truncated: boolean;
    }
  | { readonly status: 'not_found' }
  | { readonly status: 'rejected'; readonly issues: readonly ValidationIssue[] };

/** Never crosses an edition or resolves ambiguity by choosing the first hit. */
export function reanchorSameVersion(
  version: DocumentVersion,
  input: unknown,
  options: { readonly limit?: number } = {},
): ReanchorResult {
  const shape = shapeIssues(input);
  if (shape.length) return { status: 'rejected', issues: shape };
  const anchor = input as TextAnchor;
  const corpus = validateDocumentVersion(version);
  if (!corpus.valid) return { status: 'rejected', issues: corpus.issues };
  if (
    anchor.versionId !== version.id ||
    anchor.documentId !== version.documentId ||
    anchor.normalizationVersion !== version.normalizationVersion
  ) {
    return {
      status: 'rejected',
      issues: [
        {
          code: 'edition_mismatch',
          path: 'versionId',
          message: 'Reanchoring is restricted to the same document edition and normalization.',
        },
      ],
    };
  }
  if (validateAnchor(version, anchor).valid) return { status: 'unchanged', anchor };
  const limit = options.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 2 || limit > 50)
    throw new RangeError('Candidate limit must be between 2 and 50.');
  const result = locate(version, anchor, true, limit);
  if (result.truncated || result.candidates.length > 1) return { status: 'ambiguous', ...result };
  if (result.candidates.length === 0) return { status: 'not_found' };
  return { status: 'reanchored', anchor: result.candidates[0]!, requiresReview: true };
}

export type EditionSuggestions =
  | {
      readonly status: 'suggestions';
      readonly sourceVersionId: string;
      readonly targetVersionId: string;
      readonly matches: readonly {
        readonly anchor: TextAnchor;
        readonly match: 'exact_quote_and_context' | 'exact_quote';
        readonly requiresReview: true;
      }[];
      readonly truncated: boolean;
    }
  | {
      readonly status: 'not_found';
      readonly sourceVersionId: string;
      readonly targetVersionId: string;
    }
  | { readonly status: 'rejected'; readonly issues: readonly ValidationIssue[] };

/** Review-only migration proposals; the original citation is never mutated. */
export function suggestEditionAnchors(
  source: DocumentVersion,
  anchor: TextAnchor,
  target: DocumentVersion,
  options: { readonly limit?: number } = {},
): EditionSuggestions {
  const original = validateAnchor(source, anchor);
  if (!original.valid) return { status: 'rejected', issues: original.issues };
  const corpus = validateDocumentVersion(target);
  if (!corpus.valid) return { status: 'rejected', issues: corpus.issues };
  if (source.documentId !== target.documentId || source.id === target.id)
    return {
      status: 'rejected',
      issues: [
        {
          code: 'invalid_target_edition',
          path: 'target',
          message: 'Select a different edition of the same document.',
        },
      ],
    };
  const limit = options.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 2 || limit > 50)
    throw new RangeError('Candidate limit must be between 2 and 50.');
  const strict = locate(target, anchor, true, limit);
  const result =
    strict.candidates.length || strict.truncated ? strict : locate(target, anchor, false, limit);
  if (!result.candidates.length && !result.truncated)
    return { status: 'not_found', sourceVersionId: source.id, targetVersionId: target.id };
  const match = result === strict ? ('exact_quote_and_context' as const) : ('exact_quote' as const);
  return {
    status: 'suggestions',
    sourceVersionId: source.id,
    targetVersionId: target.id,
    matches: result.candidates.map((candidate) => ({
      anchor: candidate,
      match,
      requiresReview: true,
    })),
    truncated: result.truncated,
  };
}

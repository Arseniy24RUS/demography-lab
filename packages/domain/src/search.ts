import { validateDocumentVersion } from './corpus';
import { DomainValidationError } from './anchors';
import type { DocumentVersion, SearchHit, SearchResult } from './types';
import { normalizeCanonicalText, stableId } from './unicode';

export interface SearchOptions {
  readonly caseSensitive?: boolean;
  readonly foldYo?: boolean;
  readonly wholeWords?: boolean;
  readonly contextLength?: number;
  readonly limit?: number;
  readonly offset?: number;
}

interface FoldedText {
  readonly chars: readonly string[];
  readonly sourceStart: readonly number[];
  readonly sourceEnd: readonly number[];
}

/** Character expansions retain original offsets, e.g. İ → i + combining dot. */
function foldText(text: string, options: SearchOptions): FoldedText {
  const chars: string[] = [];
  const sourceStart: number[] = [];
  const sourceEnd: number[] = [];
  Array.from(text).forEach((char, index) => {
    let folded = options.caseSensitive ? char : char.toLowerCase();
    if (options.foldYo !== false) folded = folded.replace(/ё/g, 'е').replace(/Ё/g, 'Е');
    for (const unit of folded) {
      chars.push(unit);
      sourceStart.push(index);
      sourceEnd.push(index + 1);
    }
  });
  return { chars, sourceStart, sourceEnd };
}

function prefixTable(pattern: readonly string[]): number[] {
  const table = new Array<number>(pattern.length).fill(0);
  for (let i = 1, j = 0; i < pattern.length; i += 1) {
    while (j > 0 && pattern[i] !== pattern[j]) j = table[j - 1]!;
    if (pattern[i] === pattern[j]) j += 1;
    table[i] = j;
  }
  return table;
}

function boundedInteger(value: number, name: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be an integer in [${min}, ${max}].`);
}

/** A whole-document search, independent of loaded reader pages or virtual DOM nodes. */
export function searchDocument(
  version: DocumentVersion,
  query: string,
  options: SearchOptions = {},
): SearchResult {
  const corpus = validateDocumentVersion(version);
  if (!corpus.valid) throw new DomainValidationError('Invalid document version.', corpus.issues);
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;
  const contextLength = options.contextLength ?? 40;
  boundedInteger(limit, 'limit', 1, 10_000);
  boundedInteger(offset, 'offset', 0, 1_000_000);
  boundedInteger(contextLength, 'contextLength', 0, 256);
  const pattern = foldText(normalizeCanonicalText(query), options).chars;
  if (!pattern.length || !query.trim())
    return { query, hits: [], totalMatches: 0, truncated: false };
  if (pattern.length > 10_000) throw new RangeError('Search query exceeds 10,000 code points.');
  const table = prefixTable(pattern);
  const hits: SearchHit[] = [];
  let totalMatches = 0;
  const isWord = (char: string | undefined): boolean =>
    char !== undefined && /[\p{L}\p{N}_]/u.test(char);
  for (const block of version.blocks) {
    const original = Array.from(block.text);
    const folded = foldText(block.text, options);
    let matched = 0;
    for (let index = 0; index < folded.chars.length; index += 1) {
      while (matched > 0 && folded.chars[index] !== pattern[matched]) matched = table[matched - 1]!;
      if (folded.chars[index] === pattern[matched]) matched += 1;
      if (matched !== pattern.length) continue;
      const first = index - pattern.length + 1;
      const start = folded.sourceStart[first]!;
      const end = folded.sourceEnd[index]!;
      // Never return a partial match inside a case-fold expansion.
      const wholeSourceCharacters =
        (first === 0 || folded.sourceStart[first - 1] !== start) &&
        (index + 1 === folded.chars.length || folded.sourceEnd[index + 1] !== end);
      const wordBoundary =
        !options.wholeWords || (!isWord(original[start - 1]) && !isWord(original[end]));
      if (wholeSourceCharacters && wordBoundary) {
        if (totalMatches >= offset && hits.length < limit) {
          hits.push({
            id: stableId('hit', version.id, block.id, start, end),
            documentId: version.documentId,
            versionId: version.id,
            blockId: block.id,
            start,
            end,
            exact: original.slice(start, end).join(''),
            before: original.slice(Math.max(0, start - contextLength), start).join(''),
            after: original.slice(end, end + contextLength).join(''),
            ...(block.pageStart !== undefined ? { pageStart: block.pageStart } : {}),
            ...(block.pageEnd !== undefined ? { pageEnd: block.pageEnd } : {}),
          });
        }
        totalMatches += 1;
      }
      matched = table[matched - 1]!;
    }
  }
  return { query, hits, totalMatches, truncated: offset > 0 || totalMatches > hits.length };
}

/** Conservative tokenization for suggestions; no unreported stemming or semantic AI. */
export function tokenizeForMatching(text: string): readonly string[] {
  return [
    ...new Set(
      normalizeCanonicalText(text)
        .toLowerCase()
        .replace(/ё/g, 'е')
        .match(/[\p{L}\p{N}]+/gu) ?? [],
    ),
  ];
}

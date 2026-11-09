# Domain contract · release 0.1

Pure TypeScript with no runtime package, browser, database or network dependency. The public entry is `packages/domain/index.ts`; the application's alias is `@domain/index`. Public types are in `src/types.ts`. This contract is frozen for release 0.1.

## Canonical documents

A document identity and its edition identity are separate. `DocumentMeta` describes the document; `DocumentVersion` contains one immutable edition and its canonical blocks. A changed source or canonical extraction must receive a new edition identity. `sourceSha256`, when supplied, is the real SHA-256 from ingestion. `stableId` and `createBlockId` produce deterministic non-cryptographic application identifiers and must never be substituted for that digest.

```ts
import { toDocumentVersion, searchDocument, createAnchor } from '@domain/index';
const version = toDocumentVersion(extractedJson);
const result = searchDocument(version, 'компенсация', { foldYo: true });
const hit = result.hits[0];
const anchor = hit ? createAnchor(version, [hit]) : null;
```

`toDocumentVersion(unknown)` accepts the actual extracted corpus JSON or a `metadata/content` envelope; the current `{meta, version}` release envelope is accepted directly after validating the edition. It converts `versionId` into `DocumentVersion.id`, preserves the document ID, block IDs, text, source hash and normalization version, and maps source page metadata. Ingestion arrays define reading order; `ordinal` may restart on each page and is deliberately not used as the global order. Incoming position selectors are not imported by this adapter. The adapter never normalizes already hashed source text or silently selects a different edition.

The supported normalizations are `unicode-nfc-lf-v1` and the corpus's `poppler-layout-nfc-lf-rstrip-lines-blank-paragraphs-v1`. Both require valid Unicode, NFC and LF line endings; the corpus-specific extraction policy remains explicit. `normalizeCanonicalText` is an ingestion helper for new text only: it preserves spaces and does not trim lines. Unsupported normalization versions are rejected.

Source page numbers are 1-based file pages. Printed labels may differ. `DocumentBlock.kind` retains headings, paragraphs, lists, table cells or rows where ingestion actually identified them. The adapter does not invent table structure from plain extracted paragraphs.

## Anchors and DOM boundaries

A `TextAnchor` records `documentId`, `versionId`, `normalizationVersion` and ordered `spans`. Each span has `blockId`, `start`, `end`, `exact`, `prefix` and `suffix`. Offsets are **Unicode code points**, start inclusive and end exclusive. A block's original text is never collapsed for a citation. An emoji can occupy two UTF-16 code units, several code points can form one displayed grapheme, and neither is a reason to reinterpret the stored offsets.

`createAnchor(version, selections, { contextLength? })` accepts ordered nonoverlapping block selections and returns the complete selector. Default context is 48 code points on each side, bounded to 256. `createRangeAnchor(version, from, to)` expands a continuous selection into the first block's tail, full intermediate blocks and the last block's prefix; empty intermediate blocks have no text span. `anchorText(anchor)` joins the selected texts with presentation separators, which do not enter position offsets.

DOM ranges expose UTF-16 offsets. Convert them with `utf16ToCodePointOffset(block.text, domOffset)`; it rejects a boundary through a surrogate pair. For highlighting, use `codePointToUtf16Offset`. The caller must count offsets against the same block's canonical text, including text in nested inline elements. Viewport coordinates and virtualized DOM indices are not identities.

`validateAnchor(version, unknown)` is the runtime command-boundary validator. It checks document/edition/normalization membership, unique corpus block IDs, reading order, nonoverlap, safe integer offsets, exact quoted text and both contexts. It returns `{ valid: true, value, issues: [] }` or `{ valid: false, issues }` without throwing. It accepts at most 256 spans and 100,000 quoted code points. Creation factories throw `DomainValidationError` for invalid input; safe callers may use the validator before committing imported data.

## Repair and new editions

`reanchorSameVersion(version, unknownAnchor)` never changes the edition. A still-valid position returns `unchanged`. Otherwise a unique **exact quote plus exact prefix/suffix** returns `reanchored` with `requiresReview: true`; repeated matches return `ambiguous` with candidates. Search limits always set `truncated`; a truncated search can never claim uniqueness. No match returns `not_found`; a wrong edition or malformed selector returns `rejected`.

`reanchored` is a proposal to show and confirm, not an instruction to overwrite a saved citation automatically. The original object is never mutated. A repair record should retain the old selector and the explicit confirmation.

`suggestEditionAnchors(sourceVersion, originalAnchor, targetVersion)` is a distinct review-only migration API. It first validates the original citation and requires a different edition of the same document. It proposes exact quotes with context, falling back to exact quotes without the old context when necessary. Every result states its match mode and requires review. It does not perform fuzzy semantic substitution, create claims, or rewrite the original edition.

## Search

`searchDocument(version, query, options)` searches **every canonical block**, even when its reader page has not rendered. It returns `{ query, hits, totalMatches, truncated }`; the denominator remains available after pagination. Options include `caseSensitive`, `foldYo`, `wholeWords`, `contextLength`, `limit` and `offset`. Default search is case-insensitive with ё/е equivalence. Exact source text and its positions remain unchanged.

Case-conversion expansions retain mappings to original code points. A partial match inside an expanded character is rejected. Overlapping occurrences are counted. Stable hit IDs depend on edition, block and original range. Search does not cross block boundaries or apply stemming; these are explicit limitations, rather than hidden reconstruction of document wording.

## Occurrences, variants and families

`PracticeOccurrence` is an observed source fragment with its own anchor and review status. `PracticeVariant` is a concrete regional mechanism with `familyId`, `regionId`, `title`, `mechanism`, optional `eligibility`, `amount`, `conditions`, linked `occurrenceIds` and field evidence. `PracticeFamily` groups the common mechanism; it does not erase differing amounts, recipient categories, time periods or residence conditions.

The five independently reviewable fields are `title`, `mechanism`, `eligibility`, `amount` and `conditions`. `conditions` is an ordered string array. `getPracticeFieldValue` returns the exact string used by review (`conditions.join('\n')` for conditions).

A fragment `FieldEvidence` states the field, occurrence, relation (`supports`, `partial`, `contradicts`), human review status and exact `reviewedValue`. Full support requires a valid source anchor, a verified occurrence, verified field review, explicit occurrence linkage and an unchanged reviewed value. Editing a field invalidates its old verification. A known contradiction remains visible even when another fragment supports the claim. An unset value is `unknown`.

A whole-document or secondary-article reference gives at most `partial` support for its explicitly named field. A generic unscoped article link does not prove every field. Evidence is evaluated per field by `evaluateFieldEvidence` or together by `evaluatePracticeEvidence`. These functions validate structure and recorded review; they cannot prove semantic truth merely by observing a source. Human review is still required, and authenticated reviewer authorization belongs to the future server layer.

`rankPracticeCandidates(version, anchor, variants, occurrences, options)` returns ranked suggestions, never an approved link. Explicit same-edition source overlap ranks above lexical similarity. Without a source overlap, at least two informative tokens must match; generic family-policy words are excluded. Expected region, amount, recipient category and conditions can improve or reduce rank; differing regional variants remain separate. Scores are deterministic ordering aids, not probabilities, demographic effects or scientific quality estimates. Every candidate has `linkStatus: 'candidate'` and `requiresConfirmation: true`.

## Verification and boundaries

The unit suite covers surrogate boundaries and emoji, canonical normalization, duplicate block IDs, malformed offsets and selectors, multi-block ranges, overlapping and reversed spans, repeated quotes, ambiguity limits, edition separation, full-document search beyond the visible page, ё handling and lowercase expansions, field-specific review, review invalidation, article-only support, fabricated quotations and conservative ranking. A corpus adapter test exercises the actual ingestion shape and does not require a browser.

Run `npx vitest run packages/domain`. This package does not implement persistence, authentication, authorization, Realtime or multiplayer. The same runtime validators can be called from a later server command before a transaction; browser validation is not an authorization boundary. Server code must additionally verify user permissions and obtain the authoritative immutable corpus version rather than trusting a submitted document body.

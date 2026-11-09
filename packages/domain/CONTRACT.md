# Integration contract — release 0.1

The domain package has no runtime dependencies. Import from `packages/domain/src/index.ts` (a root alias may be configured by the application).

Primary exports for the reader: `NORMALIZATION_VERSION`, `normalizeCanonicalText`, `codePointLength`, `sliceCodePoints`, `codePointToUtf16Offset`, `utf16ToCodePointOffset`, `stableId`, `createBlockId`, `validateDocumentVersion`, `toDocumentVersion`, `createAnchor`, `createRangeAnchor`, `anchorText`, `validateAnchor`, `reanchorSameVersion`, `suggestEditionAnchors`, `searchDocument`.

Primary exports for cards: `getPracticeFieldValue`, `evaluateFieldEvidence`, `evaluatePracticeEvidence`, `rankPracticeCandidates`.

Types: `DocumentMeta`, `DocumentVersion`, `DocumentBlock`, `DocumentPage`, `TextAnchor`, `TextSpan`, `BlockSelection`, `TextPoint`, `PracticeOccurrence`, `PracticeVariant`, `PracticeFamily`, `FieldEvidence`, `PracticeField`, `SearchHit`, `SearchResult`.

The minimal corpus shape is:

```ts
const version: DocumentVersion = {
  id: 'edition-id', documentId: 'document-id',
  normalizationVersion: NORMALIZATION_VERSION,
  blocks: [{ id: 'block-id', order: 0, kind: 'paragraph', text: 'Canonical NFC text', pageStart: 1 }],
};
```

`createAnchor(version, [{ blockId, start, end }])` returns `TextAnchor`. Offsets are Unicode code points, end exclusive. A DOM range uses UTF-16; convert with `utf16ToCodePointOffset` before calling. `createRangeAnchor(version, {blockId, offset}, {blockId, offset})` includes intermediate blocks. The input must be in reading order. `validateAnchor(version, unknown)` returns `{valid, issues}` and `value` on success.

`searchDocument(version, query, {caseSensitive?:false, foldYo?:true, limit?:100, offset?:0})` returns `{hits,totalMatches,truncated,query}`. Each hit supplies `blockId,start,end,exact,before,after,id` and source-page metadata. Search covers all blocks, independently of the DOM.

`reanchorSameVersion(version, anchor)` yields `unchanged`, `reanchored` (requires explicit review), `ambiguous`, `not_found`, or `rejected`. `suggestEditionAnchors(sourceVersion, anchor, targetVersion)` is a separate review-only API and never rewrites the source anchor.

`PracticeVariant` flat fields: `id`, `familyId`, `title`, `mechanism`, `regionId`, optional `eligibility`, `amount`, `conditions`, required `occurrenceIds` and optional `evidence`. A candidate is never an approved semantic link. Field evidence requires a validated occurrence and an explicit human review; a document/article URL alone gives at most partial support.

No data fixtures are owned here; data adapters may attach richer metadata to the minimal types. Please keep block IDs stable within one edition and canonicalize once before computing anchors. Changes to canonical text require a new version ID.

Field contract is frozen: `PracticeField` is title | mechanism | eligibility | amount | conditions. Conditions are a readonly string array, with independently reviewable evidence. `getPracticeFieldValue(variant, field)` returns the reviewed representation.

# Immediate integration notice for root / ingestion

`@domain` resolves to `packages/domain/index.ts`, reexporting `src/index.ts`. Implemented types and early contract live in `src/types.ts` and `CONTRACT.md`.

Canonical domain shape: `DocumentVersion = { id: versionId, documentId: metadata.id, normalizationVersion, blocks: [{ id, order, kind, text, pageStart? }] }`. Corpus reader metadata remains separate. Use `toDocumentVersion` adapter (implemented in src/adapter.ts) for the actual ingestion JSON with `id`, `versionId`, `blocks[*].ordinal/type/page`.

IMPORTANT: actual ingestion JSON currently declares `extraction.offsetEncoding: utf-16-code-units`. Domain selectors are UNICODE CODE POINTS; the ingestion text is compatible, but its offset declaration needs `unicode-code-points` for new anchor data (UTF-16 is only the DOM boundary). Its canonicalization string is `poppler-layout-nfc-lf-rstrip-lines-blank-paragraphs-v1`, which the domain will recognize without re-normalizing the already hashed text. Both canonicalization IDs are supported and preserved; they must not be silently relabeled.

Factories: `createAnchor(version, [{blockId,start,end}], {contextLength?})`; `createRangeAnchor(version, {blockId,offset}, {blockId,offset})`; `anchorText(anchor)`; `validateAnchor(version, unknown)` → `{ valid, issues, value? }`; `searchDocument(version, query, options)` → `{hits,totalMatches,truncated,query}`. Hits: `id,blockId,start,end,exact,before,after,pageStart?`. DOM conversion: `utf16ToCodePointOffset`, `codePointToUtf16Offset`.

Field cards are flat `PracticeVariant` fields with an `evidence` array. Original secondary-catalog articles must be `{kind:'article',url,field?}` and are never treated as verified programme quotations. The occurrence/variant/family entities are separate. PracticeField now explicitly includes 'conditions' (readonly string array in the variant) independent of 'eligibility'. getPracticeFieldValue provides its review string. The domain is pure; it does not fetch or persist.

Tool namespace does not currently expose any collaboration/send_message tool to this child. This file is the integration handshake until direct messaging is available.

CHECKS: 30 tests pass; isolated strict TypeScript compile passes. Root tsc currently fails because TS7 removed baseUrl and requires relative ./ paths in tsconfig (TS5102/TS5090). Domain did not modify root config.

FINAL: frozen release0.1 domain exported through @domain/index. Current ingest now uses {meta, version}; adapter supports this and real Mordovia integration passed. 31 tests pass (5 files); strict isolated TypeScript with --types node passes. No root/npm files changed.

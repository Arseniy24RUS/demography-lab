# Data handoff — READY, canonical identity frozen

`public/data/corpus/index.json` contains 89 `.documents` metadata records and 80 extracted versions, 6,340 pages and 52,390 blocks. Each `documents/{id}.json` has `{meta: DocumentMeta, version: DocumentVersion, source, extraction, pageCount, textHash, canonicalHash}`. Each version has exactly one flat `.blocks` collection, pages only refer to IDs. Normalization=`unicode-nfc-lf-v1`; stored offsets=Unicode code points; multi-spans follow domain `TextAnchor`.

Source checkout verified read-only at `/workspace/scratch/685248597581/platform_source/repo`, commit `5dde46ae663b7652a448ec982585e64d61a26a61`. All 80 PDF hashes verified. Mordovia 137 pages, Perm 100, Tambov 118, Sakhalin 82. There are 79 extraction-ready versions and Moscow Oblast with blank text pages 57,70 marked review-required. Source completeness is separate: 77 full, 3 partial, 4 unavailable, 5 missing. No PDFs bundled; pinned original URLs and hashes retained. Full secondary catalogue (2,274 cards) is loaded separately from `family-catalog.json`.

`public/data/corpus/practices.json` is READY with `{families, variants, occurrences, catalogComparisons}`: 13 families, 15 real variants from four regions, 56 field-specific exact occurrences, 8 catalogue comparisons. Every anchor is multi-span Unicode codepoint based, exact text checked by domain validators. Review status stays `candidate` until an actual human semantic review; source exactness/hash verification is separately recorded. A catalog match never verifies programme amounts or eligibility.

## Canonical version identity, parent request implemented

All 80 documents and every occurrence were rebuilt. `version.id` now equals `{docid}@layout-canonical-v2-{sourceSha256prefix12}-{canonicalHashprefix12}`. The full canonical SHA-256 includes representation algorithm, normalization and segmentation versions, each block id/order/kind/page bounds/exact text, and each page number/blockIds/text hash. Thus changes to canonical text, block boundaries, page allocation or algorithm cannot reuse an old version ID. `textHash` retains the hash of the flat textual concatenation; `canonicalHash` identifies the complete immutable representation. CapturedAt is excluded from identity, so identical re-imports keep the same ID. JSON writes are atomic per file.

For initial UI use the manifest, prepared practices and only a chosen document. The 80 document texts and full catalogue total about 49.6 MB raw JSON, about 8.8 MB gzip. Source PDFs remain remote. Reader-selected excerpts can be linked directly to exact page with original URL `#page=N`.

Verification after identity rebuild: `vitest run --config scripts/ingest/vitest.config.ts` — all 4 tests passed, including all 80 canonical representation identities and all 56 anchors. Corpus JSON total 49542855 bytes, sum of per-file gzip 8740232 bytes.

## Full catalogue UI adapter — READY

`apps/web/src/lib/family-catalog.ts` now exports `loadFamilyCatalog(manifest): Promise<RichVariant[]>`, `adaptFamilyCatalog(raw, manifest): FamilyCatalogVariant[]`, `isFamilyCatalogVariant`, `EXTERNAL_CATALOG_FAMILY`, and `findPreparedCatalogVariants`. It loads only on explicit invocation, shares concurrent requests, retries errors, and binds cached raw data to each supplied manifest. 2,163 regional cards map to all 89 exact normalized territories; 111 federal cards remain `regionId=federal`; unresolved/ambiguous entries stay `unknown`.

Rich properties are `origin=catalog`, `scope`, `groupingStatus=temporary-ungrouped`, `territoryResolution`, `snapshot` (original card including detail), and `provenance` (catalog passport, content hash, fetchedAt, fieldPaths, all verification statuses unverified). The current source has no explicit eligibility or conditions fields, so both stay absent. Notes remain in the snapshot. Amount is the verbatim benefit text, including null when missing. All evidence/occurrence lists are empty; reviewStatus remains candidate.

Prepared variants remain separate; the shared `catalogId` enables lookup of eight relations via `findPreparedCatalogVariants`. Stable catalogue IDs include source repository, pinned commit, source ID and declared content hash, with a `catalog-` prefix. App.tsx and other UI files were not modified. Verification: `vitest run tests/unit/family-catalog.test.ts` — 8 tests passed; `tsc --noEmit` passed.

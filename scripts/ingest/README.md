# Canonical corpus import

The read-only source is `Arseniy24RUS/family-support` pinned to commit `5dde46ae663b7652a448ec982585e64d61a26a61`. The importer copies metadata and extracts every available regional programme with Poppler `pdftotext`. It never changes the upstream checkout. Source PDF hashes must match the pinned manifest. No original PDF binaries are included in the app: exact original URLs, source hashes and edition labels remain available for each document. Missing and unavailable records remain visible in the 89-record regional manifest.

## Run

Use Python 3.11+, Git and Poppler. Supply a clean checkout on the pinned commit; no network fetch is performed by this importer. From the project root:

```bash
python scripts/ingest/import_corpus.py --source-checkout /absolute/path/to/family-support --workers 4
python scripts/ingest/curate_practices.py
npx vitest run --config scripts/ingest/vitest.config.ts
```

`import_corpus.py` writes canonical document versions, regional provenance, geometry and the secondary catalogue. `curate_practices.py` regenerates every exact span and field-level link from the current canonical versions. Always run them together when updating an edition or ETL algorithm.

## Immutable representation and evidence

Normalization is Unicode NFC plus LF only. The version identity includes the source PDF hash and a canonical representation hash covering the algorithm, normalizer, segmenter, block contents and boundaries, and page mapping. Re-extraction with any text or structural change obtains a different version ID. Identical output retains its version ID independently of import time. Offsets are Unicode code points, never DOM UTF-16 units.

Prepared practices are editorial candidates with source-exact quotes. They are not automatically human-approved, legally current or evidence of causal effectiveness. Catalogue comparisons remain separate from citations to original programme texts. See `docs/data-catalog.md` and `reuse-manifest.json` for counts, limitations and provenance.

#!/usr/bin/env python3
"""Reproducible, read-only importer of the owner-provided family-support corpus.

python scripts/ingest/import_corpus.py --source-checkout /path/to/family-support
Requires Python 3.11+ and Poppler pdftotext. Never mutates the upstream checkout.
Offsets in future evidence refer to canonical Unicode code points, not PDF coordinates.
"""
from __future__ import annotations
import argparse, concurrent.futures, hashlib, json, re, shutil, subprocess, unicodedata
from datetime import datetime, timezone
from pathlib import Path

COMMIT = '5dde46ae663b7652a448ec982585e64d61a26a61'
REPO = 'Arseniy24RUS/family-support'
RAW = f'https://raw.githubusercontent.com/{REPO}/{COMMIT}/'
BLOB = f'https://github.com/{REPO}/blob/{COMMIT}/'
SCHEMA = 1
NORMALIZATION = 'unicode-nfc-lf-v1'
SEGMENTATION = 'blank-line-paragraphs-v1'
REPRESENTATION = 'layout-canonical-v2'

def digest(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()

def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    temporary.replace(path)

def source_path(entry):
    return 'site/' + entry['pdf_url'].removeprefix('./') if entry.get('pdf_url') else None

def clean_page(s: str) -> str:
    # Explicit, versioned canonicalisation; no word repair or inference.
    s = unicodedata.normalize('NFC', s.replace('\r\n','\n').replace('\r','\n'))
    return s

def import_one(entry, checkout: Path, out: Path, generated: str):
    path = source_path(entry)
    source = {
        'repository': REPO, 'commit': COMMIT, 'repositoryPath': path,
        'sourceUrl': BLOB + path if path else None, 'pdfUrl': RAW + path if path else None,
        'officialUrl': entry.get('official_url'), 'originalUrl': entry.get('original_url'),
        'originalFilename': entry.get('source_filename'), 'sha256': entry.get('sha256'),
        'act': entry.get('act'), 'edition': entry.get('revision'), 'period': entry.get('period'),
        'quality': entry.get('quality'), 'qualityNote': entry.get('quality_note'),
        'availability': entry.get('availability'), 'manifestPageCount': entry.get('pages'),
        'sizeBytes': entry.get('size_bytes'), 'provenanceKind': 'owner-supplied-research-corpus',
        'legalCurrency': 'unverified',
        'legalCurrencyNote': 'Текст сохранён в редакции источника; актуальность норм на дату занятия отдельно не подтверждена.',
    }
    meta = {
        'id': entry['id'], 'regionId': entry['id'].removeprefix('regional-'),
        'title': entry['title'], 'territory': entry['territory'], 'region': entry['territory'],
        'scope': 'regional', 'source': source, 'quality': entry.get('quality'),
        'availability': entry.get('availability'), 'status': 'not-available',
        'pageCount': entry.get('pages') or 0, 'blockCount': 0,
        'textUrl': None, 'importedAt': generated,
        'edition': entry.get('revision'), 'act': entry.get('act'),
    }
    if entry.get('availability') != 'available' or not path:
        return meta
    pdf = checkout / path
    if not pdf.is_file():
        meta['status'] = 'source-file-missing'; return meta
    actual_hash = digest(pdf.read_bytes())
    if actual_hash != entry.get('sha256'):
        meta['status'] = 'hash-mismatch'; meta['actualHash'] = actual_hash; return meta
    result = subprocess.run(['pdftotext','-layout','-enc','UTF-8',str(pdf),'-'], capture_output=True, check=False)
    if result.returncode:
        meta['status'] = 'extraction-failed'; meta['extractionError'] = result.stderr.decode(errors='replace')[:1500]; return meta
    raw = result.stdout.decode('utf-8')
    parts = raw.split('\f')
    if parts and not parts[-1].strip(): parts.pop()
    pages = []; blocks = []
    for i, text in enumerate(parts, 1):
        canonical = clean_page(text)
        page_blocks = []
        # Preserve paragraph newlines and exact text; only empty-line boundaries split.
        for j, block_text in enumerate(re.split(r'\n[ \t]*\n+', canonical), 1):
            if not block_text.strip(): continue
            block_id = f'{entry["id"]}-p{i:03d}-b{j:03d}'
            block = {
                'id': block_id, 'order': len(blocks), 'kind': 'paragraph', 'pageStart': i, 'pageEnd': i,
                'text': block_text, 'textHash': digest(block_text.encode('utf-8')),
            }
            blocks.append(block); page_blocks.append(block_id)
        pages.append({'number': i, 'blockIds': page_blocks, 'textHash': digest(canonical.encode('utf-8')), 'sourceUrl': RAW + path + '#page=' + str(i)})
    text_hash = digest('\n\n'.join(b['text'] for b in blocks).encode('utf-8'))
    # Identity includes text, block boundaries/order/pages, normalizer and segmenter.
    # A changed ETL representation can never reuse the same immutable edition ID.
    canonical_identity = [REPRESENTATION, NORMALIZATION, SEGMENTATION,
        [[b['id'], b['order'], b['kind'], b['pageStart'], b['pageEnd'], b['text']] for b in blocks],
        [[p['number'], p['blockIds'], p['textHash']] for p in pages]]
    canonical_hash = digest(json.dumps(canonical_identity, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    version_id = f'{entry["id"]}@{REPRESENTATION}-{actual_hash[:12]}-{canonical_hash[:12]}'
    warnings = []
    if len(parts) != entry.get('pages'): warnings.append('extracted-page-count-differs-from-manifest')
    empty_pages = [p['number'] for p in pages if not p['blockIds']]
    if empty_pages: warnings.append('empty-text-pages')
    doc = {
        'schemaVersion': SCHEMA,
        'meta': {
            'id': entry['id'], 'title': entry['title'], 'regionId': entry['id'].removeprefix('regional-'),
            'regionName': entry['territory'], 'kind': 'programme', 'sourceUrl': BLOB + path,
            'availability': 'partial' if entry.get('quality') == 'partial' else 'full',
            'notes': source['legalCurrencyNote'] + (' ' + entry['quality_note'] if entry.get('quality_note') else ''),
        },
        'version': {
            'id': version_id, 'documentId': entry['id'], 'normalizationVersion': NORMALIZATION,
            'blocks': blocks, 'pages': pages, 'editionLabel': entry.get('revision'),
            'capturedAt': generated, 'sourceSha256': actual_hash, 'sourceUrl': RAW + path,
            'sourceFileName': entry.get('source_filename'),
            'completeness': 'partial' if entry.get('quality') == 'partial' else 'full',
        },
        'source': source, 'pageCount': len(parts),
        'extraction': {
            'engine': 'pdftotext', 'mode': 'layout-preserving',
            'engineVersion': subprocess.run(['pdftotext','-v'], capture_output=True).stderr.decode().split('\n')[0],
            'canonicalization': NORMALIZATION, 'segmentation': SEGMENTATION,
            'representationVersion': REPRESENTATION,
            'offsetEncoding': 'unicode-code-points', 'ocrPerformed': False,
            'sourceHashVerified': True, 'emptyPages': empty_pages, 'warnings': warnings,
            'status': 'complete' if not warnings else 'review-required',
            'note': 'Извлечённый текст не восстанавливает визуальную структуру таблиц. Для проверки таблиц используйте PDF указанной редакции.',
        },
        'textHash': text_hash, 'canonicalHash': canonical_hash,
    }
    write_json(out/'documents'/f'{entry["id"]}.json', doc)
    meta.update({'status':'ready' if not warnings else 'review-required','versionId': version_id,
                 'pageCount':len(parts),'blockCount':len(blocks),'textUrl':f'/data/corpus/documents/{entry["id"]}.json',
                 'textHash':doc['textHash'],'canonicalHash': canonical_hash,'extractionWarnings': warnings,'emptyPages':empty_pages})
    return meta

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-checkout', required=True, type=Path)
    parser.add_argument('--output', default='public/data/corpus', type=Path)
    parser.add_argument('--workers', default=4, type=int)
    args = parser.parse_args(); checkout = args.source_checkout.resolve(); out=args.output
    head=subprocess.check_output(['git','-C',str(checkout),'rev-parse','HEAD'], text=True).strip()
    if head != COMMIT: raise SystemExit(f'Wrong source commit {head}; expected {COMMIT}. No import was performed.')
    check=subprocess.run(['git','-C',str(checkout),'diff','--quiet',COMMIT,'--','site/data/strategies.json','site/data/measures.json','site/data/details','site/data/ru-regions.geojson'])
    if check.returncode: raise SystemExit('Pinned metadata files have local modifications; refusing ambiguous provenance.')
    manifest_file = checkout/'site/data/strategies.json'
    manifest = json.loads(manifest_file.read_text())
    regional = [x for x in manifest['documents'] if x.get('group')=='regional']
    generated = datetime.now(timezone.utc).isoformat()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        results = list(executor.map(lambda x:import_one(x,checkout,out,generated), regional))
    source = {'repository':REPO,'commit':COMMIT,'manifestUrl':BLOB+'site/data/strategies.json',
              'manifestSha256':digest(manifest_file.read_bytes()),'manifestGeneratedAt':manifest.get('generated_at'),
              'receivedAt':manifest.get('corpus_received_at')}
    stats = {
        'regionalTotal':len(results),'ready':sum(x['status']=='ready' for x in results),
        'reviewRequired':sum(x['status']=='review-required' for x in results),
        'availableSourceFiles':sum(x['availability']=='available' for x in results),
        'fullSources':sum(x['quality']=='full' for x in results),'partialSources':sum(x['quality']=='partial' for x in results),
        'unavailableSources':sum(x['availability']=='unavailable' for x in results),
        'missingSources':sum(x['availability']=='missing' for x in results),
        'pages':sum(x['pageCount'] for x in results if x['textUrl']),
        'blocks':sum(x['blockCount'] for x in results),
    }
    write_json(out/'index.json',{'schemaVersion':SCHEMA,'generatedAt':generated,'source':source,
        'featuredDocumentIds':['regional-respublika-mordoviia','regional-permskii-krai','regional-tambovskaia-oblast','regional-sakhalinskaia-oblast'],
        'scopeNote':'89 паспортов территорий сохранены в составе авторского корпуса. Это состав набора данных, а не утверждение об исчерпывающем наборе действующих программ.',
        'stats':stats,'documents':results})
    # Preserve the existing lightweight regional boundaries with exact attribution metadata.
    geometry=checkout/'site/data/ru-regions.geojson'
    shutil.copyfile(geometry, out.parent/'regions.geojson')
    write_json(out.parent/'regions.provenance.json',{'sourceRepository':REPO,'sourceCommit':COMMIT,
        'sourcePath':'site/data/ru-regions.geojson','sourceUrl':BLOB+'site/data/ru-regions.geojson',
        'sha256':digest(geometry.read_bytes()),'featureCount':89,
        'licenseStatus':'unspecified-upstream','codeMappingStatus':'name-alias-only-not-oktmo',
        'use':'visual navigation only; no statistical use of legacy population properties'})
    # Catalog is a separate provenance layer, not verified evidence for program text.
    catalog_path=checkout/'site/data/measures.json'
    catalog=json.loads(catalog_path.read_text())
    details={}
    for shard in sorted((checkout/'site/data/details').glob('[0-9][0-9].json')):
        details.update(json.loads(shard.read_text()))
    write_json(out/'family-catalog.json',{'schemaVersion':SCHEMA,'source':{
        'repository':REPO,'commit':COMMIT,'path':'site/data/measures.json',
        'url':BLOB+'site/data/measures.json','sha256':digest(catalog_path.read_bytes()),
        'originalSource':'https://app.sovetmam.ru/catalog','fetchedAt':'2026-10-01T06:02:44.718Z',
        'status':'secondary-catalog-not-verified-program-citation'},
        'measures':[{**x,'detail':details.get(x['id']),'programCitationStatus':'unverified'} for x in catalog]})
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    failed=[x['id'] for x in results if x['availability']=='available' and not x['textUrl']]
    if failed: raise SystemExit('Some documents not imported: '+','.join(failed))

if __name__=='__main__': main()

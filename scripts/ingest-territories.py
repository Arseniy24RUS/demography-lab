#!/usr/bin/env python3
"""Compile pinned author-supplied geography and reported actual municipal series.

Requires pyarrow==21.0.0. No population/area values from map properties are used.
No upstream projection is relabelled as an observation. Missing values remain null.
"""
from __future__ import annotations
import argparse
import concurrent.futures
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import re
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ALGORITHM = 'territories-1'
GEO_COMMIT = '08c68f1fe1c812ed059b0b124b25c26c6fdd374f'
DATA_COMMIT = '59b778760c9efa6fe30d6ad17beec6ea622f30b5'
GEO_EDITION = 'rudn-08c68f1fe1c8-2025-10-28'
DATA_EDITION = 'spd-59b778760c9e-actual-v1'
EDITION = 'territories-v1-rudn-08c68f1fe1c8-spd-59b778760c9e'
COLUMNS = ['year', 'births_total', 'deaths_total', 'pop_mid', 'mig_in_total', 'mig_out_total', 'mig_net_total', 'natural_change']
START, END = 2008, 2023

METRICS = [
    {'id': 'births_total', 'label': 'Число родившихся', 'unit': 'persons', 'kind': 'flow', 'reference': 'calendar_year', 'signed': False, 'sourceField': 'births_total', 'sourceKind': 'source_reported', 'definition': 'Число родившихся за календарный год в авторском наборе, обозначенном actual; первичная выгрузка и территориальная гармонизация отдельно не подтверждены.'},
    {'id': 'deaths_total', 'label': 'Число умерших', 'unit': 'persons', 'kind': 'flow', 'reference': 'calendar_year', 'signed': False, 'sourceField': 'deaths_total', 'sourceKind': 'source_reported', 'definition': 'Число умерших за календарный год в авторском наборе, обозначенном actual.'},
    {'id': 'pop_mid', 'label': 'Среднегодовая численность населения', 'unit': 'persons', 'kind': 'stock', 'reference': 'annual_average', 'signed': False, 'sourceField': 'pop_mid', 'sourceKind': 'source_reported', 'definition': 'Среднегодовая численность из поля pop_mid. Не численность на 1 января, не сумма переписных поселений и не модельная численность будущего года. Для суммирования по времени показатель запаса неприменим.'},
    {'id': 'mig_in_total', 'label': 'Число прибывших', 'unit': 'persons', 'kind': 'flow', 'reference': 'calendar_year', 'signed': False, 'sourceField': 'mig_in_total', 'sourceKind': 'source_reported', 'definition': 'Число прибывших за календарный год в исходной территориальной и методической классификации автора.'},
    {'id': 'mig_out_total', 'label': 'Число выбывших', 'unit': 'persons', 'kind': 'flow', 'reference': 'calendar_year', 'signed': False, 'sourceField': 'mig_out_total', 'sourceKind': 'source_reported', 'definition': 'Число выбывших за календарный год в исходной территориальной и методической классификации автора.'},
    {'id': 'mig_net_total', 'label': 'Миграционный прирост', 'unit': 'persons', 'kind': 'flow', 'reference': 'calendar_year', 'signed': True, 'sourceField': 'mig_net_total', 'sourceKind': 'source_reported', 'definition': 'Сальдо прибытий и выбытий за календарный год; отрицательное значение означает миграционную убыль. При импорте проверяется равенство прибывшие минус выбывшие.'},
    {'id': 'natural_change', 'label': 'Естественный прирост', 'unit': 'persons', 'kind': 'flow', 'reference': 'calendar_year', 'signed': True, 'sourceField': 'births_total - deaths_total', 'sourceKind': 'calculated', 'definition': 'Число родившихся минус число умерших за один календарный год. Вычисляется только при наличии обоих компонентов; пропуск не заменяется нулём.'},
]

def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def dump(path: Path, value) -> str:
    raw = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_bytes(raw)
    temp.replace(path)
    return digest(raw)

def check_input(path: Path, record: dict) -> bool:
    if not path.exists():
        return False
    raw = path.read_bytes()
    return len(raw) == record['bytes'] and digest(raw) == record['sha256'] and hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() == record['gitBlobSha']

def acquire(cache: Path, record: dict, download: bool):
    path = cache / record['cachePath']
    if check_input(path, record):
        return
    if not download:
        raise ValueError(f"Missing or changed pinned source: {path}; pass --download to retrieve the exact pinned commit.")
    url = f"https://raw.githubusercontent.com/{record['repository']}/{record['commit']}/{record['path']}"
    with urllib.request.urlopen(url, timeout=60) as response:
        raw = response.read()
    if len(raw) != record['bytes'] or digest(raw) != record['sha256']:
        raise ValueError('Source digest mismatch: ' + record['path'])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)
    if not check_input(path, record):
        raise ValueError('Source Git blob mismatch: ' + record['path'])

def normalize_region(value: str) -> str:
    value = value.casefold().replace('ё', 'е')
    value = re.sub(r'\([^)]*\)', '', value)
    value = re.sub(r'\b(город федерального значения|город|г)\b', '', value)
    value = value.replace('федерального значения', '')
    return re.sub(r'[^а-яa-z0-9]', '', value)

def unit_kind(properties: dict, region_id: str) -> tuple[str, str, str]:
    if region_id in {'moskva', 'sankt-peterburg'}:
        return 'administrative_district', 'administrative_district', 'federal_city_administrative_layer'
    text = (properties.get('names_rosstat', '') + ' ' + properties.get('name', '')).casefold()
    if region_id == 'sevastopol' and ('муниципальн' in text):
        return 'municipality', 'intraurban_municipality', 'source_names_rosstat'
    for phrase, kind in [('муниципальный район', 'municipal_district'), ('муниципальный округ', 'municipal_okrug'), ('городской округ', 'urban_okrug')]:
        if phrase in text:
            return 'municipality', kind, 'source_names_rosstat'
    # A bare historical district label does not establish municipal status.
    return 'administrative_district', 'source_district', 'source_label_only'

def normalize_municipality(value: str) -> tuple[str | None, str]:
    text = value.casefold().replace('ё', 'е')
    text = re.sub(r'\bмр\b', 'муниципальный район', text)
    text = re.sub(r'\bго\b', 'городской округ', text)
    text = re.sub(r'\bмо\b', 'муниципальный округ', text)
    kind = None
    for phrase, name in [('муниципальный район', 'municipal_district'), ('муниципальный округ', 'municipal_okrug'), ('городской округ', 'urban_okrug')]:
        if phrase in text:
            kind = name
            text = text.replace(phrase, '')
            break
    text = re.sub(r'\b(город|города|г)\b', '', text)
    text = re.sub(r'[^а-яa-z0-9]', '', text)
    return kind, text

def finite_number(value):
    if value is None or not math.isfinite(value):
        return None
    return int(value) if value == int(value) else value

def polygon_groups(feature: dict):
    geometry = feature['geometry']
    if geometry['type'] == 'Polygon':
        return [geometry['coordinates']]
    if geometry['type'] == 'MultiPolygon':
        return geometry['coordinates']
    raise ValueError('Unsupported geometry ' + geometry['type'])

def in_ring(point, ring):
    x, y = point
    inside = False
    for i in range(len(ring)):
        x1, y1 = ring[i - 1]
        x2, y2 = ring[i]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside

def inside_polygon(point, polygon):
    return in_ring(point, polygon[0]) and not any(in_ring(point, ring) for ring in polygon[1:])

def ring_area(ring):
    return abs(sum(ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1] for i in range(len(ring)))) / 2

def label_point(polygons):
    polygon = max(polygons, key=lambda p: ring_area(p[0]))
    ring = polygon[0]
    xs, ys = [p[0] for p in ring], [p[1] for p in ring]
    minimum, maximum = (min(xs), min(ys)), (max(xs), max(ys))
    center = ((minimum[0] + maximum[0]) / 2, (minimum[1] + maximum[1]) / 2)
    if inside_polygon(center, polygon):
        return list(center)
    # An interior point is preferable to a centroid outside a concave municipality.
    candidates = []
    for row in range(1, 31):
        for col in range(1, 31):
            p = (minimum[0] + (maximum[0] - minimum[0]) * col / 31, minimum[1] + (maximum[1] - minimum[1]) * row / 31)
            if inside_polygon(p, polygon):
                candidates.append(p)
    if candidates:
        return list(min(candidates, key=lambda p: (p[0] - center[0]) ** 2 + (p[1] - center[1]) ** 2))
    return list(ring[0])

def compile_map(features: list, region_id: str, subject_id: str):
    all_points = [p for feature in features for poly in polygon_groups(feature) for ring in poly for p in ring]
    # The supplied Chukotka shard uses positive unwrapped longitudes beyond 180°.
    # Accept one geographic revolution and normalize cyclically below.
    if any(len(p) < 2 or not math.isfinite(p[0]) or not math.isfinite(p[1]) or abs(p[0]) > 360 or abs(p[1]) > 90 for p in all_points):
        raise ValueError('Invalid source coordinate')
    # A circular origin avoids stretching Chukotka across the antimeridian.
    origin = math.degrees(math.atan2(sum(math.sin(math.radians(p[0])) for p in all_points), sum(math.cos(math.radians(p[0])) for p in all_points)))
    latitude = (min(p[1] for p in all_points) + max(p[1] for p in all_points)) / 2
    cosine = math.cos(math.radians(latitude))
    def project(point):
        lon = origin + ((point[0] - origin + 180) % 360 - 180)
        return [lon * cosine, -point[1]]
    projected = [project(p) for p in all_points]
    minx, maxx = min(p[0] for p in projected), max(p[0] for p in projected)
    miny, maxy = min(p[1] for p in projected), max(p[1] for p in projected)
    scale = min(1104 / max(maxx - minx, 0.000001), 704 / max(maxy - miny, 0.000001))
    left, top = (1200 - (maxx - minx) * scale) / 2, (800 - (maxy - miny) * scale) / 2
    def xy(point):
        x, y = project(point)
        return [round(left + (x - minx) * scale, 1), round(top + (y - miny) * scale, 1)]
    def n(value):
        return str(int(value)) if value == int(value) else str(value)
    shapes = []
    for feature in features:
        polygons = [[[xy(p) for p in ring] for ring in poly] for poly in polygon_groups(feature)]
        segments = []
        for polygon in polygons:
            for ring in polygon:
                # Rounded adjacent duplicates do not carry additional display geometry.
                compact = [p for j, p in enumerate(ring) if not j or p != ring[j - 1]]
                if len(compact) < 3:
                    continue
                segments.append('M' + 'L'.join(n(p[0]) + ',' + n(p[1]) for p in compact) + 'Z')
        points = [p for poly in polygons for ring in poly for p in ring]
        if not segments:
            raise ValueError('Empty rendered geometry: ' + str(feature['id']))
        position = [round(p, 1) for p in label_point(polygons)]
        shapes.append({'territoryKey': 'rudn-mun-' + str(feature['id']), 'geometryId': str(feature['id']), 'path': ''.join(segments), 'bounds': [min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)], 'labelPoint': position})
    return {'schemaVersion': 1, 'editionId': EDITION, 'geographyEditionId': GEO_EDITION, 'regionId': region_id, 'viewBox': [0, 0, 1200, 800], 'projection': {'name': 'local-equirectangular-layout', 'referenceLatitude': latitude, 'longitudeOrigin': origin, 'precisionPixels': 0.1}, 'sourceId': 'rudn-geometry-' + subject_id, 'shapes': shapes, 'note': 'Контуры предоставленного автором набора; карта служит навигации и распределению работы. Проекция локальная, координаты округлены до 0,1 пикселя; площади и расстояния по этому изображению не рассчитываются. Заполнение колец: evenodd.'}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=ROOT / '.cache/territory-sources')
    parser.add_argument('--output', type=Path, default=ROOT / 'public/data/territories')
    parser.add_argument('--download', action='store_true')
    args = parser.parse_args()
    import pyarrow.parquet as pq
    lock = json.loads((ROOT / 'scripts/territories-source-lock.json').read_text())
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda r: acquire(args.cache, r, args.download), lock['files']))
    inputs = {r['cachePath']: r for r in lock['files']}
    corpus = json.loads((ROOT / 'public/data/corpus/index.json').read_text())
    catalogue = json.loads((args.cache / 'rudn/catalog.json').read_text())
    by_region = {normalize_region(r['region']): r for r in corpus['documents']}
    assert len(by_region) == 89
    subjects = []
    aliases = {}
    for subject in catalogue['subjects']:
        region = by_region.get(normalize_region(subject['name']))
        if region is None:
            raise ValueError('Unresolved region ' + subject['name'])
        for name in (subject['name'], subject.get('source_name', ''), region['region']):
            aliases[normalize_region(name)] = region['regionId']
        subjects.append((subject, region))
    # Explicit source aliases with the same named federal city or republic.
    aliases[normalize_region('Республика Татарстан')] = 'respublika-tatarstan-tatarstan'
    aliases[normalize_region('Чувашская Республика')] = 'chuvashskaia-respublika-chuvashiia'
    aliases[normalize_region('Республика Адыгея')] = 'respublika-adygeia-adygeia'
    settlements = pq.read_table(args.cache / 'data/settlement_index.parquet').to_pylist()
    actual = pq.read_table(args.cache / 'data/municipal_components_actual.parquet').to_pylist()
    source_municipalities = {}
    for row in settlements:
        key = row['oktmo_syn']
        if not key:
            continue
        region_id = aliases.get(normalize_region(row['Region'] or ''))
        entry = source_municipalities.setdefault(key, {'sourceKey': key, 'regionId': region_id, 'names': set(), 'regionNames': set(), 'codes': set()})
        if entry['regionId'] != region_id:
            raise ValueError('A source key crosses different normalized regions: ' + key)
        entry['names'].add(row['Municipality'] or '')
        entry['regionNames'].add(row['Region'])
        if row['oktmo_stable']:
            entry['codes'].add(row['oktmo_stable'])
    rows_by_key = defaultdict(dict)
    unlinked = 0
    missing = Counter()
    for row in actual:
        key = row['oktmo_syn']
        if not key:
            unlinked += 1
            continue
        year = row['year']
        if not START <= year <= END or year in rows_by_key[key]:
            raise ValueError('Unexpected or repeated source key/year')
        values = [finite_number(row.get(c)) for c in COLUMNS[1:7]]
        for j, metric in enumerate(COLUMNS[1:7]):
            value = values[j]
            if value is None:
                missing[metric] += 1
            elif metric not in {'mig_net_total'} and value < 0:
                raise ValueError('Negative nonnegative metric')
            if value is not None and metric not in {'pop_mid', 'mig_net_total'} and int(value) != value:
                raise ValueError('Fractional count')
        births, deaths, _, arrivals, departures, balance = values
        if arrivals is not None and departures is not None and balance is not None and abs(arrivals - departures - balance) > 0.0000001:
            raise ValueError('Migration identity mismatch')
        natural = None if births is None or deaths is None else births - deaths
        rows_by_key[key][year] = [year, *values, natural]
    candidates = defaultdict(set)
    for key, source in source_municipalities.items():
        if source['regionId'] is None:
            continue
        for name in source['names']:
            kind, normalized = normalize_municipality(name)
            if kind:
                candidates[(source['regionId'], kind, normalized)].add(key)
    records = []
    features_by_region = {}
    proposed = defaultdict(list)
    candidates_by_id = {}
    for subject, region in subjects:
        features = json.loads((args.cache / f"rudn/subject-{subject['id']}.geojson").read_text())['features']
        if len(features) != subject['units']:
            raise ValueError('Geometry count mismatch')
        features_by_region[region['regionId']] = features
        for feature in features:
            p = feature['properties']
            if str(feature['id']) != str(p['id']) or str(p['subject_id']) != str(subject['id']):
                raise ValueError('Geometry identity mismatch')
            level, kind, basis = unit_kind(p, region['regionId'])
            key = 'rudn-mun-' + str(feature['id'])
            found = set()
            if level == 'municipality' and kind != 'intraurban_municipality':
                for name in (p.get('names_rosstat', ''), p.get('name', '')):
                    candidate_kind, normalized = normalize_municipality(name)
                    if candidate_kind == kind:
                        found.update(candidates.get((region['regionId'], kind, normalized), set()))
            candidates_by_id[key] = found
            if len(found) == 1:
                proposed[next(iter(found))].append(key)
            records.append({'territoryKey': key, 'level': level, 'unitKind': kind, 'name': p.get('names_rosstat') or p['name'], 'regionId': region['regionId'], 'sourceEditionId': GEO_EDITION, 'sourceCode': None, 'geographicStatus': 'historical_source_snapshot', 'geometryId': str(feature['id']), 'sourceRegionId': str(subject['id']), 'sourceName': p['name'], 'classificationBasis': basis, 'roomEligible': level == 'municipality', 'statistics': None})
    crosswalk = []
    for record in records:
        found = candidates_by_id[record['territoryKey']]
        match = next(iter(found)) if len(found) == 1 else None
        ambiguous = len(found) > 1 or (match is not None and len(proposed[match]) != 1)
        if match is not None and not ambiguous:
            src = source_municipalities[match]
            code = next(iter(src['codes'])) if len(src['codes']) == 1 else None
            has_series = any(any(v is not None for v in row[1:]) for row in rows_by_key.get(match, {}).values())
            record['sourceCode'] = code
            record['statistics'] = {'status': 'matched', 'sourceMunicipalityKey': match, 'sourceCode': code, 'sourceNames': sorted(src['names']), 'matchingRule': 'unique_name_and_type_in_region', 'hasSeries': has_series, 'note': 'Однозначное соответствие названия и типа в одном субъекте. Тождество исторических границ и гармонизация временного ряда отдельно не подтверждены. Код источника не удостоверяет актуальный ОКТМО.'}
        else:
            record['statistics'] = {'status': 'not_applicable' if record['level'] != 'municipality' else ('ambiguous' if ambiguous else 'unmatched'), 'sourceMunicipalityKey': None, 'sourceCode': None, 'sourceNames': [], 'matchingRule': None, 'hasSeries': False, 'note': 'Статистика не присоединена: однозначное соответствие территории и типа не установлено. Данные другого уровня или переименованной территории автоматически не переносятся.'}
        crosswalk.append({'territoryKey': record['territoryKey'], 'name': record['name'], 'regionId': record['regionId'], 'unitKind': record['unitKind'], 'status': record['statistics']['status'], 'matchedSourceKey': record['statistics']['sourceMunicipalityKey'], 'candidateSourceKeys': sorted(found)})
    empty_statistics = {'status': 'not_applicable', 'sourceMunicipalityKey': None, 'sourceCode': None, 'sourceNames': [], 'matchingRule': None, 'hasSeries': False, 'note': 'Муниципальные ряды не агрегируются автоматически до регионального или федерального уровня.'}
    for subject, region in subjects:
        records.append({'territoryKey': 'region:' + region['regionId'], 'level': 'region', 'unitKind': 'region', 'name': region['region'], 'regionId': region['regionId'], 'sourceEditionId': 'corpus-5dde46ae663b-scope-v1', 'sourceCode': None, 'geographicStatus': 'corpus_scope', 'geometryId': None, 'sourceRegionId': str(subject['id']), 'sourceName': region['region'], 'classificationBasis': 'corpus_scope', 'roomEligible': True, 'statistics': dict(empty_statistics)})
    records.append({'territoryKey': 'federal:ru', 'level': 'federal', 'unitKind': 'federal', 'name': 'Российская Федерация', 'regionId': None, 'sourceEditionId': 'corpus-5dde46ae663b-scope-v1', 'sourceCode': None, 'geographicStatus': 'corpus_scope', 'geometryId': None, 'sourceRegionId': None, 'sourceName': 'Российская Федерация', 'classificationBasis': 'corpus_scope', 'roomEligible': True, 'statistics': dict(empty_statistics)})
    records.sort(key=lambda r: r['territoryKey'])
    assert len(records) == 2471 and len({r['territoryKey'] for r in records}) == len(records)
    mordovia = [r for r in records if r['regionId'] == 'respublika-mordoviia' and r['level'] == 'municipality']
    assert len(mordovia) == 23 and all(r['statistics']['status'] == 'matched' for r in mordovia), 'Mordovia must have 23 unique type-preserving links'
    assert len({r['statistics']['sourceMunicipalityKey'] for r in mordovia}) == 23
    registry_sha = dump(args.output / 'registry.json', {'schemaVersion': 1, 'editionId': EDITION, 'records': records})
    def source_record(path, title, id_, status, license_, vintage, note):
        entry = inputs[path]
        return {'id': id_, 'title': title, 'repository': entry['repository'], 'commit': entry['commit'], 'sourcePath': entry['path'], 'url': f"https://github.com/{entry['repository']}/blob/{entry['commit']}/{entry['path']}", 'sha256': entry['sha256'], 'license': license_, 'vintage': vintage, 'provenanceStatus': status, 'note': note}
    data_note = 'Авторский производный набор, обозначенный actual. В репозитории отсутствуют точный паспорт первичной выгрузки БДМО, дата каждого наблюдения и таблица гармонизации границ. СКР, ОКС, экспозиции и upstream-прогнозы не импортируются в эти ряды.'
    sources = [source_record('data/municipal_components_actual.parquet', 'Муниципальные компоненты: авторский набор actual', 'spd-actual', 'incomplete_primary', 'CC BY 4.0 для авторских данных; условия первичных поставщиков сохраняются', '2008–2023', data_note), source_record('data/settlement_index.parquet', 'Авторский индекс населённых пунктов и муниципальных ключей', 'spd-settlement-index', 'incomplete_primary', 'CC BY 4.0 для авторских данных; условия первичных поставщиков сохраняются', '1989, 2002, 2010, 2021', 'Используются только названия, типы и авторские ключи муниципалитетов. Население и координаты поселений не превращаются в текущие муниципальные значения.'), source_record('rudn/catalog.json', 'Каталог предоставленной муниципальной геометрии', 'rudn-municipal-catalog', 'owner_supplied_geography', catalogue['license'], catalogue.get('source_archive_date'), 'Содержит также административные районы и исторические территориальные единицы. Набор не удостоверяет актуальный официальный состав муниципалитетов.')]
    regions = []
    for subject, region in sorted(subjects, key=lambda pair: pair[1]['regionId']):
        region_id = region['regionId']
        local = [r for r in records if r['regionId'] == region_id and r['geometryId'] is not None]
        series = []
        for record in local:
            link = record['statistics']
            if link['status'] == 'matched' and link['hasSeries']:
                source_key = link['sourceMunicipalityKey']
                rows = [rows_by_key[source_key].get(y, [y, *([None] * 7)]) for y in range(START, END + 1)]
                series.append({'territoryKey': record['territoryKey'], 'sourceMunicipalityKey': source_key, 'rows': rows})
        pack = {'schemaVersion': 1, 'editionId': EDITION, 'statisticsEditionId': DATA_EDITION, 'geographyEditionId': GEO_EDITION, 'regionId': region_id, 'sourceId': 'spd-actual', 'provenanceStatus': 'incomplete_primary', 'geographyComparability': 'not_verified', 'columns': COLUMNS, 'series': sorted(series, key=lambda s: s['territoryKey'])}
        map_pack = compile_map(features_by_region[region_id], region_id, str(subject['id']))
        map_path = f'regions/{region_id}.map.json'
        statistics_path = f'regions/{region_id}.statistics.json'
        map_sha = dump(args.output / map_path, map_pack)
        statistics_sha = dump(args.output / statistics_path, pack)
        regions.append({'regionId': region_id, 'name': region['region'], 'sourceRegionId': str(subject['id']), 'geographyCount': len(local), 'municipalityCount': sum(r['level'] == 'municipality' for r in local), 'matchedStatisticsCount': sum(r['statistics']['status'] == 'matched' for r in local), 'availableSeriesCount': len(series), 'mapPath': '/data/territories/' + map_path, 'mapSha256': map_sha, 'statisticsPath': '/data/territories/' + statistics_path, 'statisticsSha256': statistics_sha})
        sources.append(source_record(f"rudn/subject-{subject['id']}.geojson", 'Контуры: ' + region['region'], 'rudn-geometry-' + str(subject['id']), 'owner_supplied_geography', catalogue['license'], catalogue.get('source_archive_date'), 'Навигационная геометрия. Исходные population, area_km2 и density_km2 намеренно исключены; содержательные статистические значения по ним не восстанавливаются.'))
    coverage = {'regions': len(regions), 'geographicUnits': sum(r['geographyCount'] for r in regions), 'municipalities': sum(r['municipalityCount'] for r in regions), 'administrativeUnits': sum(r['level'] == 'administrative_district' for r in records), 'matchedStatistics': sum(r['matchedStatisticsCount'] for r in regions), 'availableStatistics': sum(r['availableSeriesCount'] for r in regions), 'unlinkedSourceRows': unlinked, 'observationYears': [START, END]}
    warnings = ['Используется зафиксированный авторский набор; актуальность административного состава на дату занятия отдельно не удостоверена.', 'Сведения обозначены в источнике как actual; первичная выгрузка БДМО и территориальная гармонизация не представлены. Источник нельзя называть полной БДМО Росстата.', 'Пропуски сохраняются. Последний доступный год определяется отдельно для каждого показателя и муниципалитета.', 'Попытка сопоставления использует уникальное совпадение названия, типа и региона. Изменение муниципального типа не игнорируется; неоднозначные и несопоставленные единицы остаются без статистики.', 'Коды oktmo_syn и oktmo_stable взяты из авторского набора и не удостоверяют актуальный официальный ОКТМО.', 'Москва и Санкт-Петербург представлены административными районами; они не предлагаются как муниципальные комнаты. Для работы по городу выбирается региональный уровень.', 'Данные прогнозов withMIG/noMIG и расчётные муниципальные СКР не включены в наблюдаемые ряды этого выпуска.']
    warnings.append('Саранск, pop_mid: в исходном actual за 2011 год указано 27 766 человек, за 2012 год значение отсутствует, за 2013 год указано 327 477,5 человека. Это резкое несогласованное изменение исходного уровня; требуется проверка первичного источника. Значения не исправлены и не интерполированы.')
    index = {'schemaVersion': 1, 'editionId': EDITION, 'algorithmVersion': ALGORITHM, 'geographyEditionId': GEO_EDITION, 'statisticsEditionId': DATA_EDITION, 'registryPath': '/data/territories/registry.json', 'registrySha256': registry_sha, 'metrics': METRICS, 'sources': sources, 'regions': regions, 'coverage': coverage, 'warnings': warnings}
    index_sha = dump(args.output / 'index.json', index)
    used_keys = {r['statistics']['sourceMunicipalityKey'] for r in records if r['statistics']['sourceMunicipalityKey'] is not None}
    unmatched_source = [{'sourceKey': k, 'regionId': v['regionId'], 'names': sorted(v['names']), 'regionNames': sorted(v['regionNames']), 'codes': sorted(v['codes']), 'hasActual': k in rows_by_key} for k, v in sorted(source_municipalities.items()) if k not in used_keys]
    audit = {'schemaVersion': 1, 'editionId': EDITION, 'coverage': coverage, 'source': {'settlementRows': len(settlements), 'sourceRegionLabels': len({r['Region'] for r in settlements}), 'sourceMunicipalityKeys': len(source_municipalities), 'actualRows': len(actual), 'actualLinkedRows': len(actual) - unlinked, 'unlinkedRowsRejected': unlinked, 'duplicateLinkedKeyYears': 0, 'missingLinkedValues': dict(missing)}, 'crosswalk': crosswalk, 'unmatchedSourceMunicipalities': unmatched_source, 'mordovia': [{'territoryKey': r['territoryKey'], 'name': r['name'], 'sourceMunicipalityKey': r['statistics']['sourceMunicipalityKey'], 'sourceNames': r['statistics']['sourceNames']} for r in mordovia]}
    dump(args.output / 'crosswalk-audit.json', audit)
    print(json.dumps({'indexSha256': index_sha, 'registrySha256': registry_sha, 'coverage': coverage, 'sourceRows': len(actual), 'mordoviaMatches': len(mordovia)}, ensure_ascii=False))

if __name__ == '__main__':
    main()

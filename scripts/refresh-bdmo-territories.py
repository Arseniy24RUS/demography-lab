"""Extend the pinned roadmap data using reviewed BDMO observations and crosswalk.

Inputs are the extracted annual municipal totals and reviewed registry matches.
Run on a clean checkout of the previous release. The maps retain their geometry.
"""

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path


METRIC_COLUMNS = {
    'Y48112003': 1, 'Y48112001': 2, 'Y48112013': 3,
    'Y48112021': 4, 'Y48112022': 5, 'Y48112023': 6,
}
SOURCE_ID = 'bdmo-112-v20260928'
EDITION = 'territories-v1-rudn-08c68f1fe1c8-bdmo-20260928'


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    path.write_bytes((json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode())
    return digest(path)


def compatible_migration(row):
    arrivals, departures, balance = row[4:7]
    return None in (arrivals, departures, balance) or arrivals - departures == balance


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('observations', type=Path)
    cli.add_argument('crosswalk', type=Path)
    cli.add_argument('--output', type=Path, default=Path('public/data/territories'))
    args = cli.parse_args()
    root = args.output
    old_index = read(root / 'index.json')
    registry = read(root / 'registry.json')
    source, crosswalk = read(args.observations), read(args.crosswalk)
    if source['release'] != '112_v20260928' or digest(root / 'registry.json') != crosswalk['registrySha256']:
        raise ValueError('Unexpected BDMO or registry edition')
    if any(source['sources'][sec]['sha256'] != crosswalk['sources'][i]['sha256']
           for i, sec in enumerate(('31', '41'))):
        raise ValueError('Crosswalk and observations use different source files')

    matches = {record['territoryKey']: record for record in crosswalk['records'] if record['status'] == 'matched'}
    names_by_source = {
        (m['bdmoRegionId'], m['bdmoRegionName'], m['bdmoOktmo'], m['bdmoType']): key
        for key, m in matches.items()
    }
    if len(names_by_source) != len(matches):
        raise ValueError('Crosswalk repeats a source territory')
    candidates = defaultdict(dict)
    for code, region, region_name, _, oktmo, _, kind, year, amount, _ in source['rows']:
        key = names_by_source.get((region, region_name, oktmo, kind))
        if key is None:
            continue
        position = (year, METRIC_COLUMNS[code])
        if position in candidates[key] and candidates[key][position] != amount:
            raise ValueError(f'Ambiguous observation: {key} {position}')
        candidates[key][position] = int(amount) if amount == int(amount) else amount
    if set(candidates) != set(matches):
        raise ValueError('Crosswalk contains a match without observations')

    records = {r['territoryKey']: r for r in registry['records']}
    added = Counter()
    blocked_migration = 0
    updated = set()
    newly_available = set()
    nonempty_years = set()
    index = old_index
    index['editionId'] = registry['editionId'] = EDITION
    index['statisticsEditionId'] = 'spd-actual-plus-bdmo-112-v20260928'
    index['algorithmVersion'] = 'territories-2'
    index['sources'].append({
        'id': SOURCE_ID,
        'title': 'Муниципальная статистика России с 2005 года. Росстат, обработка «Если быть точным»',
        'repository': 'Если быть точным', 'commit': None,
        'sourcePath': '112_v20260928, разделы 31 и 41',
        'url': 'https://tochno.st/datasets/bdmo', 'sha256': source['manifest_sha256'],
        'license': 'Creative Commons BY 4.0', 'vintage': '28.09.2026',
        'provenanceStatus': 'incomplete_primary',
        'note': 'SHA-256 манифеста локального пакета. ' + ' '.join(
            f"Раздел {sec}: {source['sources'][sec]['sha256']}." for sec in ('31', '41')
        ) + ' Использованы годовые значения по муниципальным образованиям верхнего уровня.',
    })
    for region in index['regions']:
        region_id = region['regionId']
        statistics_path = root / 'regions' / f'{region_id}.statistics.json'
        map_path = root / 'regions' / f'{region_id}.map.json'
        pack, map_pack = read(statistics_path), read(map_path)
        pack['editionId'] = map_pack['editionId'] = EDITION
        pack['statisticsEditionId'] = index['statisticsEditionId']
        groups = {group['territoryKey']: group for group in pack['series']}
        for key, match in matches.items():
            if match['regionId'] != region_id:
                continue
            record = records[key]
            link = record['statistics']
            group = groups.get(key)
            if group is None:
                newly_available.add(key)
                source_key = link['sourceMunicipalityKey'] or 'bdmo-' + match['bdmoOktmo']
                group = groups[key] = {'territoryKey': key, 'sourceMunicipalityKey': source_key, 'rows': []}
                record['sourceCode'] = match['bdmoOktmo']
                record['statistics'] = {
                    'status': 'matched', 'sourceMunicipalityKey': source_key,
                    'sourceCode': match['bdmoOktmo'], 'sourceNames': match['names'],
                    'matchingRule': 'unique_name_and_type_in_region', 'hasSeries': True,
                    'note': 'Однозначное совпадение региона, названия и типа. История границ отдельно не проверена.',
                }
            rows = {r[0]: list(r) for r in group['rows']}
            by_year = defaultdict(dict)
            for (year, position), amount in candidates[key].items():
                by_year[year][position] = amount
            changes = []
            for year, values in sorted(by_year.items()):
                row = rows.get(year, [year] + [None] * 7)
                previous = list(row)
                for position, amount in values.items():
                    if row[position] is None:
                        row[position] = amount
                if not compatible_migration(row):
                    # Retain both independent gross flows if only published balance disagrees.
                    if previous[6] is None:
                        row[6] = None
                    else:
                        row[4:7] = previous[4:7]
                    blocked_migration += 1
                if not compatible_migration(row):
                    raise ValueError(f'Inconsistent previous migration values: {key} {year}')
                row[7] = row[1] - row[2] if row[1] is not None and row[2] is not None else None
                mask = 0
                for pos in range(1, 8):
                    if previous[pos] is None and row[pos] is not None:
                        mask |= 1 << (pos - 1)
                        added[pack['columns'][pos]] += 1
                if mask:
                    rows[year] = row
                    changes.append([year, mask])
            if changes:
                group['rows'] = [rows[y] for y in sorted(rows)]
                group['bdmo'] = {'sourceId': SOURCE_ID, 'oktmo': match['bdmoOktmo'], 'added': changes}
                updated.add(key)
            elif not group['rows']:
                raise ValueError(f'No usable data for newly matched territory: {key}')
        pack['series'] = sorted(groups.values(), key=lambda group: group['territoryKey'])
        nonempty_years.update(row[0] for group in pack['series'] for row in group['rows'] if any(v is not None for v in row[1:]))
        region['availableSeriesCount'] = len(groups)
        region['matchedStatisticsCount'] = sum(r['regionId'] == region_id and r['statistics']['status'] == 'matched' for r in records.values())
        region['statisticsSha256'] = write(statistics_path, pack)
        region['mapSha256'] = write(map_path, map_pack)

    index['registrySha256'] = write(root / 'registry.json', registry)
    index['coverage']['matchedStatistics'] = sum(r['matchedStatisticsCount'] for r in index['regions'])
    index['coverage']['availableStatistics'] = sum(r['availableSeriesCount'] for r in index['regions'])
    index['coverage']['observationYears'] = [min(nonempty_years), max(nonempty_years)]
    index['warnings'].insert(0, 'Авторские ряды дополнены наблюдениями БДМО из выпуска от 28 сентября 2026 года при однозначной идентификации муниципалитета. Годы дополнений указаны в паспорте каждого ряда.')
    for i, metric in enumerate(index['metrics']):
        metric['definition'] = (
            'Среднегодовая численность населения.' if i == 2 else
            'Разность между числом родившихся и умерших за календарный год.' if i == 6 else
            metric['label'] + ' за календарный год.'
        )
    index_hash = write(root / 'index.json', index)
    audit_path = root / 'crosswalk-audit.json'
    audit = read(audit_path)
    audit['editionId'] = EDITION
    audit['coverage'] = index['coverage']
    audit['bdmo'] = {
        'sourceRelease': source['release'], 'sourceManifestSha256': source['manifest_sha256'],
        'crosswalkSha256': digest(args.crosswalk), 'matched': len(matches),
        'updatedTerritories': len(updated), 'newTerritoriesWithSeries': len(newly_available),
        'addedObservations': dict(added), 'inconsistentMigrationRows': blocked_migration,
        'matchingOutcomes': crosswalk['counts'],
        'unresolvedTerritories': [
            {'territoryKey': r['territoryKey'], 'reason': r['reason']}
            for r in crosswalk['records'] if r['status'] != 'matched'
        ],
    }
    write(audit_path, audit)
    print(json.dumps({'indexSha256': index_hash, 'coverage': index['coverage'], **{
        k:v for k,v in audit['bdmo'].items() if k != 'unresolvedTerritories'
    }}, ensure_ascii=False))


if __name__ == '__main__':
    main()

"""Extract age/sex structure and migration directions from BDMO for matched municipalities."""

import argparse
from collections import defaultdict
import gzip
from hashlib import sha256
from itertools import groupby
import json
import math
from pathlib import Path
import re

import duckdb


STOCK = {'Y48112014': 'all', 'Y48112015': 'urban', 'Y48112016': 'rural'}
FLOWS = {'Y48112021': 0, 'Y48112022': 1, 'Y48112023': 2}
SEX = {'Мужчины': 0, 'Женщины': 1}
AREAS = {'Все население': 'all', 'Городское население': 'urban', 'Сельское население': 'rural'}
DIRECTIONS = {
    'Миграция — всего': 'all', 'Внутрирегиональная': 'within_region',
    'Межрегиональная': 'interregional', 'Международная': 'international',
    'В пределах России': 'within_russia', 'Внешняя (для региона) миграция': 'outside_region',
    'Со странами СНГ': 'cis', 'С другими зарубежными странами': 'other_international',
    'Городские поселения': 'urban_destinations',
}
ANNUAL = {
    'Y48112004': 'natural_reported', 'Y48112007': 'birth_rate',
    'Y48112008': 'death_rate', 'Y48112009': 'natural_rate',
}
AGE_OPEN = {'70 и старше': 70, '100 и более лет': 100}
AGE_RANGE = re.compile(r'(\d{1,3})‒(\d{1,3})')


def digest(path):
    with path.open('rb') as stream:
        hasher = sha256()
        for chunk in iter(lambda: stream.read(2 ** 20), b''):
            hasher.update(chunk)
        return hasher.hexdigest()


def encode(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')


def exact_range(label):
    if label == 'Всего':
        return -1, -1
    if label in AGE_OPEN:
        return AGE_OPEN[label], None
    match = AGE_RANGE.fullmatch(label or '')
    if match:
        start, end = map(int, match.groups())
        if start % 5 == 0 and end == start + 4 and 0 <= start < 100:
            return start, end
    return None


def profile(cells):
    total = cells.get((-1, -1))
    open_ages = sorted(start for start, end in cells if end is None)
    first_open = None
    if open_ages:
        first_open = open_ages[-1]
        for start in reversed(open_ages[:-1]):
            if not all(any(value is not None for value in cells.get((age, age + 4), []))
                       for age in range(start, first_open, 5)):
                first_open = start
    ages = [(start, end, *values) for (start, end), values in sorted(
        cells.items(), key=lambda item: (item[0][0], item[0][1] is None)
    ) if start >= 0 and (first_open is None or
        (end is None and start == first_open) or (end is not None and end < first_open))]
    return total, ages


def pack_territory(rows):
    stocks = defaultdict(dict)
    flows = defaultdict(dict)
    sex_flows = defaultdict(dict)
    annual = defaultdict(list)
    conflicts = 0
    for _, _, code, year, sex, age_raw, direction, place, low, high in rows:
        if low != high:
            conflicts += 1
            continue
        if low is None or not math.isfinite(low):
            continue
        observed = int(low) if int(low) == low else low
        if code in STOCK:
            age = exact_range(age_raw)
            if age is not None and observed >= 0 and isinstance(observed, int):
                stock = stocks[(year, STOCK[code])]
                stock.setdefault(age, [None, None])[SEX[sex]] = observed
        elif code in FLOWS:
            age = exact_range(age_raw) or ((-1, -1) if age_raw == 'CD' else None)
            if age is None or (observed < 0 and code != 'Y48112023') or not isinstance(observed, int):
                continue
            column = FLOWS[code]
            if sex in SEX:
                counts = sex_flows[(year, DIRECTIONS[direction], column)].setdefault(age, [None, None])
                counts[SEX[sex]] = observed
                continue
            values = flows[(year, DIRECTIONS[direction])].setdefault(age, [None, None, None])
            if values[column] is not None and values[column] != observed:
                # Different source totals ('CD' and 'Всего') cannot be combined.
                values[column] = math.nan
                conflicts += 1
            else:
                values[column] = observed
        elif code in ANNUAL or code == 'Y48112027':
            metric = ANNUAL[code] if code in ANNUAL else 'population_january_' + AREAS[place]
            annual[metric].append([year, observed])

    population = []
    for (year, residence), cells in sorted(stocks.items()):
        total, ages = profile(cells)
        if ages:
            population.append([year, residence, total, ages])
    migration = []
    for (year, direction), cells in sorted(flows.items()):
        for row in cells.values():
            for i, value in enumerate(row):
                if isinstance(value, float) and math.isnan(value):
                    row[i] = None
        total, ages = profile(cells)
        if ages or (total and any(v is not None for v in total)):
            migration.append([year, direction, total, ages])
    migration_sex = []
    slices = sorted({(year, direction) for year, direction, _ in sex_flows})
    for year, direction in slices:
        arrivals = profile(sex_flows.get((year, direction, FLOWS['Y48112021']), {}))[1]
        departures = profile(sex_flows.get((year, direction, FLOWS['Y48112022']), {}))[1]
        if arrivals or departures:
            migration_sex.append([year, direction, arrivals, departures])
    return {'population': population, 'migration': migration, 'migrationSex': migration_sex,
            'annual': dict(sorted(annual.items()))}, conflicts


def results(cursor):
    while rows := cursor.fetchmany(40000):
        yield from rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('section31', type=Path)
    parser.add_argument('crosswalk', type=Path)
    parser.add_argument('--registry', type=Path, default=Path('public/data/territories/registry.json'))
    parser.add_argument('--output', type=Path, default=Path('public/data/demography'))
    args = parser.parse_args()
    registry = json.loads(args.registry.read_bytes())
    records = {item['territoryKey']: item for item in registry['records']}
    crosswalk = json.loads(args.crosswalk.read_bytes())
    source_hash = digest(args.section31)
    expected_section = next(s for s in crosswalk['sources'] if s['path'].replace('\\', '/').endswith('/bdmo_31.parquet'))
    if source_hash != expected_section['sha256']:
        raise ValueError('Section 31 differs from the reviewed crosswalk')
    db = duckdb.connect()
    db.execute('create table matched(territory_key varchar, region_key varchar, region_id varchar, region_name varchar, oktmo varchar, mun_type varchar, unique(region_id,region_name,oktmo,mun_type))')
    matched = []
    for row in crosswalk['records']:
        if row['status'] != 'matched':
            continue
        record = records.get(row['territoryKey'])
        if not record or record['level'] != 'municipality' or record['regionId'] != row['regionId'] or record['unitKind'] != row['unitKind']:
            raise ValueError('Territory or classification changed after crosswalk')
        matched.append((row['territoryKey'], row['regionId'], row['bdmoRegionId'],
                        row['bdmoRegionName'], row['bdmoOktmo'], row['bdmoType']))
    if not matched:
        raise ValueError('No reviewed BDMO matches')
    db.executemany('insert into matched values (?,?,?,?,?,?)', matched)
    ids = list(STOCK) + list(FLOWS) + list(ANNUAL) + ['Y48112027']
    keep_age = ['Всего', *AGE_OPEN, *(f'{i}‒{i+4}' for i in range(0, 100, 5))]
    query = """
    SELECT m.region_key,m.territory_key,b.indicator_code,b.year,b.grup_2,b.vozr,
      b.migr,b.mest,min(b.indicator_value),max(b.indicator_value)
    FROM read_parquet(?) b
    JOIN matched m ON m.region_id=b.region_id AND m.region_name=b.region_name
      AND m.oktmo=b.oktmo AND m.mun_type=b.mun_type
    WHERE b.mun_type=b.mun_type_oktmo AND b.mun_level='Муниципальное образование верхнего уровня'
      AND b.indicator_code=ANY(?) AND b.year BETWEEN 2005 AND 2025 AND b.indicator_value IS NOT NULL
      AND (
        (b.indicator_code=ANY(?) AND b.grup_2=ANY(?) AND b.vozr=ANY(?) AND b.indicator_period='На 1 января')
        OR (((b.indicator_code=ANY(?) AND b.grup_2='Всего' AND b.vozr=ANY(?))
          OR (b.indicator_code=ANY(?) AND b.grup_2=ANY(?) AND b.vozr=ANY(?))) AND b.migr=ANY(?)
          AND b.indicator_period='Значение показателя за год')
        OR (b.indicator_code=ANY(?) AND b.grup_2='CD' AND b.vozr='CD' AND b.migr='CD' AND b.mest='CD'
          AND b.indicator_period='Значение показателя за год')
        OR (b.indicator_code='Y48112027' AND b.grup_2='CD' AND b.vozr='CD' AND b.migr='CD'
          AND b.mest=ANY(?) AND b.indicator_period='На 1 января')
      )
    GROUP BY ALL
    ORDER BY m.region_key,m.territory_key,b.indicator_code,b.year,b.grup_2,b.vozr,b.migr,b.mest
    """
    cursor = db.execute(query, [str(args.section31), ids, list(STOCK), list(SEX), keep_age,
                               list(FLOWS), [*keep_age, 'CD'],
                               ['Y48112021', 'Y48112022'], list(SEX), keep_age[1:],
                               list(DIRECTIONS), list(ANNUAL), list(AREAS)])
    regions = []
    conflicts = 0
    coverage = defaultdict(int)
    directory = args.output
    directory.mkdir(parents=True, exist_ok=True)
    for region, regional_rows in groupby(results(cursor), key=lambda row: row[0]):
        territories = {}
        for key, rows in groupby(regional_rows, key=lambda row: row[1]):
            material, skipped = pack_territory(rows)
            conflicts += skipped
            if any(material.values()):
                territories[key] = material
                for kind, content in material.items():
                    coverage[kind] += bool(content)
        if not territories:
            continue
        source = encode({'schemaVersion': 1, 'regionId': region, 'territories': territories})
        packed = gzip.compress(source, compresslevel=6, mtime=0)
        filename = f'{region}.json.gz'
        (directory / filename).write_bytes(packed)
        regions.append({'id': region, 'path': filename, 'sha256': sha256(packed).hexdigest(), 'count': len(territories)})
    if not regions or not all(coverage[kind] for kind in ('population', 'migration', 'migrationSex')):
        raise ValueError('Missing BDMO demographic profiles')
    index = {
        'schemaVersion': 1, 'source': 'БДМО Росстата, обработка «Если быть точным»',
        'sourceUrl': 'https://tochno.st/datasets/bdmo', 'sourceVersion': '112_v20260928',
        'sourceSection31Sha256': source_hash, 'registryEditionId': registry['editionId'],
        'regions': regions, 'matched': len(matched), 'coverage': dict(coverage),
        'conflictingCellsOmitted': conflicts,
    }
    (directory / 'index.json').write_bytes(encode(index))
    print(json.dumps({'regions': len(regions), 'coverage': index['coverage'], 'conflicts': conflicts}))


if __name__ == '__main__':
    main()

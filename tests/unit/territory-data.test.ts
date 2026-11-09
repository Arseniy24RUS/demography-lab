import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseTerritoryDataIndex, parseTerritoryRegistry, parseTerritoryMapPack, parseRegionStatisticsPack, parseCanonicalMunicipalSeries } from '../../packages/territories/schema';
import { adaptCanonicalSeries, canonicalSeriesFingerprint, canonicalSeriesText, verifyCanonicalSeriesFingerprint } from '../../packages/territories/series.mjs';

const read = (path: string) => JSON.parse(readFileSync(`public${path}`, 'utf8'));
const sha = (path: string) => createHash('sha256').update(readFileSync(`public${path}`)).digest('hex');
const index = parseTerritoryDataIndex(read('/data/territories/index.json'));
const registry = parseTerritoryRegistry(read(index.registryPath));
const mordovia = index.regions.find((region) => region.regionId === 'respublika-mordoviia')!;
const pack = parseRegionStatisticsPack(read(mordovia.statisticsPath));
const ardatovId = 'rudn-mun-72196-894';

describe('pinned territories and source-aware coverage', () => {
  it('retains all source geometries while distinguishing municipal and administrative units', () => {
    expect(index.coverage).toMatchObject({ regions: 89, geographicUnits: 2381, municipalities: 2325, administrativeUnits: 56, matchedStatistics: 1729, availableStatistics: 1725, unlinkedSourceRows: 2946 });
    expect(registry.records).toHaveLength(2471);
    expect(registry.records.filter((record) => record.level === 'region')).toHaveLength(89);
    expect(registry.records.filter((record) => record.level === 'federal')).toHaveLength(1);
    expect(sha(index.registryPath)).toBe(index.registrySha256);
    expect(registry.records.filter((record) => record.level === 'administrative_district').every((record) => !record.roomEligible && !record.statistics.hasSeries)).toBe(true);
  });

  it('verifies every lazy shard hash, identity, coverage and bounded geometry', () => {
    let geometryCount = 0, statisticsCount = 0;
    for (const region of index.regions) {
      expect(sha(region.mapPath)).toBe(region.mapSha256);
      expect(sha(region.statisticsPath)).toBe(region.statisticsSha256);
      const map = parseTerritoryMapPack(read(region.mapPath));
      const statistics = parseRegionStatisticsPack(read(region.statisticsPath));
      expect(map.regionId).toBe(region.regionId);
      expect(statistics.regionId).toBe(region.regionId);
      expect(map.editionId).toBe(index.editionId);
      expect(statistics.editionId).toBe(index.editionId);
      const local = registry.records.filter((record) => record.regionId === region.regionId && record.geometryId !== null);
      expect(new Set(map.shapes.map((shape) => shape.territoryKey))).toEqual(new Set(local.map((record) => record.territoryKey)));
      expect(map.shapes.length).toBe(region.geographyCount);
      expect(statistics.series.length).toBe(region.availableSeriesCount);
      geometryCount += map.shapes.length;
      statisticsCount += statistics.series.length;
    }
    expect(geometryCount).toBe(2381);
    expect(statisticsCount).toBe(1725);
  });

  it('keeps each of the 23 reviewed Mordovia matches one-to-one', () => {
    const expected: Record<string, string> = {
      '203': '89634000__234cd2a2', '2381': '89621000__616a024b', '249': '89640000__a1f9587f',
      '269': '89649000__7cdbffee', '335': '89651000__c39cb21b', '894': '89603000__9ef49d49',
      '895': '89613000__edf1d7c5', '896': '89607000__eb937f72', '897': '89626000__cfcda339',
      '898': '89637000__2b0f7df3', '899': '89646000__73e9b715', '900': '89618000__58639ea5',
      '901': '89657000__168dab3c', '902': '89616000__5b969ee0', '903': '89610000__b3cb6c4f',
      '904': '89701000__1585ce3d', '905': '89628000__adbfdfe6', '906': '89624000__f6fdb9c0',
      '907': '89643000__46e9f641', '924': '89631000__b0eecbca', '925': '89629000__0a813ca6',
      '926': '89605000__9f63fa1d', '927': '89654000__e43ad330',
    };
    const records = registry.records.filter((record) => record.regionId === mordovia.regionId && record.level === 'municipality');
    expect(records).toHaveLength(23);
    for (const record of records) {
      expect(record.statistics.sourceMunicipalityKey).toBe(expected[record.geometryId!.split('-')[1]]);
      expect(record.statistics.hasSeries).toBe(true);
      expect(record.sourceCode).not.toBe(record.territoryKey);
    }
    expect(new Set(records.map((record) => record.statistics.sourceMunicipalityKey)).size).toBe(23);
  });

  it('does not allocate a whole federal-city time series to administrative districts', () => {
    for (const [regionId, count] of [['moskva', 12], ['sankt-peterburg', 18]] as const) {
      const region = index.regions.find((entry) => entry.regionId === regionId)!;
      expect(region.geographyCount).toBe(count);
      expect(region.municipalityCount).toBe(0);
      expect(parseRegionStatisticsPack(read(region.statisticsPath)).series).toEqual([]);
      expect(registry.records.find((entry) => entry.territoryKey === `region:${regionId}`)?.roomEligible).toBe(true);
    }
  });

  it('quarantines ambiguous and unmatched geography instead of copying a plausible namesake', () => {
    const ambiguous = registry.records.filter((entry) => entry.statistics.status === 'ambiguous');
    expect(ambiguous).toHaveLength(8);
    for (const entry of registry.records.filter((entry) => entry.statistics.status !== 'matched')) {
      expect(entry.statistics.sourceMunicipalityKey).toBeNull();
      expect(entry.statistics.hasSeries).toBe(false);
    }
  });

  it('uses genuine wrapped Chukotka geometry without a world-spanning layout', () => {
    const region = index.regions.find((entry) => entry.regionId === 'chukotskii-avtonomnyi-okrug')!;
    const map = parseTerritoryMapPack(read(region.mapPath));
    expect(Math.abs(map.projection.longitudeOrigin)).toBeGreaterThan(150);
    expect(map.shapes.every((shape) => shape.bounds[0] >= 47.9 && shape.bounds[2] <= 1152.1 && shape.bounds[1] >= 47.9 && shape.bounds[3] <= 752.1)).toBe(true);
    expect(map.shapes.some((shape) => shape.bounds[2] - shape.bounds[0] > 100)).toBe(true);
  });

  it('retains licenses and primary-provenance limitations and excludes upstream model outputs', () => {
    expect(index.metrics.map((metric) => metric.id)).toEqual(['births_total', 'deaths_total', 'pop_mid', 'mig_in_total', 'mig_out_total', 'mig_net_total', 'natural_change']);
    expect(index.sources.find((source) => source.id === 'spd-actual')).toMatchObject({ commit: '59b778760c9efa6fe30d6ad17beec6ea622f30b5', sha256: 'd2c059daf8628d5879c1e8bcc4f5c703ae00e8144ac266fac4d6799bdc496bf3', provenanceStatus: 'incomplete_primary' });
    expect(index.sources.find((source) => source.id === 'rudn-municipal-catalog')?.license).toContain('Условия исходного набора не указаны');
    expect(index.metrics.find((metric) => metric.id === 'pop_mid')).toMatchObject({ kind: 'stock', reference: 'annual_average', sourceKind: 'source_reported' });
    expect(index.metrics.find((metric) => metric.id === 'natural_change')?.sourceKind).toBe('calculated');
  });
});

describe('actual counts, missing values and immutable source series', () => {
  it('preserves actual Ardatov values independently read from the source parquet', () => {
    const rows = pack.series.find((series) => series.territoryKey === ardatovId)!.rows;
    expect(rows.find((row) => row[0] === 2014)).toEqual([2014, 253, 512, 26951.5, 651, 917, -266, -259]);
    expect(rows.find((row) => row[0] === 2023)).toEqual([2023, null, null, null, 699, 603, 96, null]);
    expect(rows.find((row) => row[0] === 2011)).toEqual([2011, null, null, null, null, null, null, null]);
  });

  it('exposes separate latest valid years rather than a common last year with invented zeroes', async () => {
    const series = await adaptCanonicalSeries(index, registry, pack);
    const births = series.find((entry) => entry.territoryKey === ardatovId && entry.metricId === 'births_total')!;
    const arrivals = series.find((entry) => entry.territoryKey === ardatovId && entry.metricId === 'mig_in_total')!;
    expect(births.points.filter((point) => point.value !== null).at(-1)?.year).toBe(2022);
    expect(arrivals.points.filter((point) => point.value !== null).at(-1)?.year).toBe(2023);
    expect(births.points.find((point) => point.year === 2023)?.value).toBeNull();
    expect(series.every((entry) => entry.geographyComparability === 'not_verified' && entry.provenanceStatus === 'incomplete_primary')).toBe(true);
  });

  it('builds schema-valid fingerprints that are stable under object key ordering', async () => {
    const series = (await adaptCanonicalSeries(index, registry, pack))[0];
    expect(parseCanonicalMunicipalSeries(series)).toEqual(series);
    expect(await verifyCanonicalSeriesFingerprint(series)).toBe(true);
    const reordered = Object.fromEntries(Object.entries(series).reverse()) as typeof series;
    expect(canonicalSeriesText(reordered)).toBe(canonicalSeriesText(series));
    expect(await canonicalSeriesFingerprint(reordered)).toBe(series.fingerprint);
    expect(await verifyCanonicalSeriesFingerprint({ ...series, sourceMunicipalityKey: 'different_source_key' })).toBe(false);
    expect(await verifyCanonicalSeriesFingerprint({ ...series, points: series.points.map((point, i) => i === 5 ? { ...point, value: 999 } : point) })).toBe(false);
  });

  it('keeps the known Saransk anomaly visible in the sealed series without repairing its value', async () => {
    const stock = (await adaptCanonicalSeries(index, registry, pack)).find((series) => series.territoryKey === 'rudn-mun-72196-904' && series.metricId === 'pop_mid')!;
    expect(stock.points.find((point) => point.year === 2011)?.value).toBe(27766);
    expect(stock.points.find((point) => point.year === 2012)?.value).toBeNull();
    expect(stock.points.find((point) => point.year === 2013)?.value).toBe(327477.5);
    expect(index.warnings.some((warning) => warning.startsWith('Саранск, pop_mid:'))).toBe(true);
    expect(stock.comparabilityNote).toContain('Саранск, pop_mid:');
    expect(stock.comparabilityNote).toContain('2011');
    expect(await verifyCanonicalSeriesFingerprint(stock)).toBe(true);
  });

  it('rejects changed territory binding, source edition, or duplicate group before flattening', async () => {
    const broken = structuredClone(pack);
    broken.series[0].sourceMunicipalityKey = 'other_municipality';
    await expect(adaptCanonicalSeries(index, registry, broken)).rejects.toThrow('территории');
    await expect(adaptCanonicalSeries(index, registry, { ...pack, geographyEditionId: 'changed' })).rejects.toThrow('Редакции');
    await expect(adaptCanonicalSeries(index, registry, { ...pack, series: [pack.series[0], pack.series[0]] })).rejects.toThrow('территории');
  });

  it('rejects nonphysical counts and manufactured natural balance when a component is missing', () => {
    const invalid = structuredClone(pack);
    invalid.series[0].rows[0] = [2008, null, 40, null, null, null, null, -40];
    expect(() => parseRegionStatisticsPack(invalid)).toThrow();
    invalid.series[0].rows[0] = [2008, 2.5, 40, 100, null, null, null, -37.5];
    expect(() => parseRegionStatisticsPack(invalid)).toThrow();
    invalid.series[0].rows[0] = [2008, 2, 40, -100, null, null, null, -38];
    expect(() => parseRegionStatisticsPack(invalid)).toThrow();
    invalid.series[0].rows[0] = [2008, 2, 40, 100, 10, 12, 2, -38];
    expect(() => parseRegionStatisticsPack(invalid)).toThrow();
  });

  it('rejects duplicate years and source keys', () => {
    const invalid = structuredClone(pack);
    invalid.series[0].rows[1][0] = invalid.series[0].rows[0][0];
    expect(() => parseRegionStatisticsPack(invalid)).toThrow();
    const duplicate = structuredClone(pack);
    duplicate.series[1].sourceMunicipalityKey = duplicate.series[0].sourceMunicipalityKey;
    expect(() => parseRegionStatisticsPack(duplicate)).toThrow();
  });

  it('rejects semantic relabeling of annual-average population as a demographic flow', () => {
    const invalid = structuredClone(index);
    invalid.metrics.find((metric) => metric.id === 'pop_mid')!.kind = 'flow';
    expect(() => parseTerritoryDataIndex(invalid)).toThrow();
  });

  it('rejects executable SVG content and paths escaping the pinned data subtree', () => {
    const map = read(mordovia.mapPath);
    map.shapes[0].path = '<script>alert(1)</script>';
    expect(() => parseTerritoryMapPack(map)).toThrow();
    const invalid = structuredClone(index);
    invalid.regions[0].mapPath = '/data/territories/../../secrets.json';
    expect(() => parseTerritoryDataIndex(invalid)).toThrow();
  });
});

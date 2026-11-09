import { z } from 'zod';
import type { CanonicalMunicipalSeries, RegionStatisticsPack, TerritoryDataIndex, TerritoryMapPack, TerritoryRegistry } from './types';

const text = (max: number, min = 0) => z.string().min(min).max(max).refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9:_-]+$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const commit = z.string().regex(/^[a-f0-9]{40}$/u);
const count = z.number().int().min(0).max(10000000);
const year = z.number().int().min(1900).max(2100);
const amount = z.number().finite().min(-1e12).max(1e12);
const publicPath = z.string().regex(/^\/data\/territories\/(?:registry\.json|regions\/[a-z0-9-]+\.(?:map|statistics)\.json)$/u);
const httpsUrl = z.url().max(1500).refine((value) => value.startsWith('https://'));
const metricId = z.enum(['births_total', 'deaths_total', 'pop_mid', 'mig_in_total', 'mig_out_total', 'mig_net_total', 'natural_change']);
const sourceKind = z.enum(['source_reported', 'calculated']);
const sameSemantics = (value: { id?: string; metricId?: string; kind?: string; semanticType?: string; signed?: boolean; valueDomain?: string; reference: string; sourceKind: string }) => {
  const metric = value.id ?? value.metricId;
  const isPopulation = metric === 'pop_mid';
  const isSigned = metric === 'mig_net_total' || metric === 'natural_change';
  return (value.kind ?? value.semanticType) === (isPopulation ? 'stock' : 'flow')
    && value.reference === (isPopulation ? 'annual_average' : 'calendar_year')
    && (value.signed ?? (value.valueDomain === 'signed')) === isSigned
    && value.sourceKind === (metric === 'natural_change' ? 'calculated' : 'source_reported');
};

export const municipalMetricDefinitionSchema = z.strictObject({
  id: metricId, label: text(200, 1), unit: z.literal('persons'), kind: z.enum(['stock', 'flow']),
  reference: z.enum(['annual_average', 'calendar_year']), signed: z.boolean(), sourceField: text(200, 1),
  sourceKind, definition: text(2000, 1),
}).refine(sameSemantics, 'Смысл показателя не соответствует его исходному полю.');

const statisticsLink = z.strictObject({
  status: z.enum(['matched', 'unmatched', 'ambiguous', 'not_applicable']), sourceMunicipalityKey: id.nullable(),
  sourceCode: text(100, 1).nullable(), sourceNames: z.array(text(500, 1)).max(30),
  matchingRule: z.literal('unique_name_and_type_in_region').nullable(), hasSeries: z.boolean(), note: text(2000, 1),
}).refine((value) => value.status === 'matched'
  ? value.sourceMunicipalityKey !== null && value.matchingRule !== null && value.sourceNames.length > 0
  : value.sourceMunicipalityKey === null && value.sourceCode === null && value.matchingRule === null && !value.hasSeries && value.sourceNames.length === 0);

export const territoryRecordSchema = z.strictObject({
  territoryKey: id, level: z.enum(['municipality', 'administrative_district', 'region', 'federal']),
  unitKind: z.enum(['municipal_district', 'municipal_okrug', 'urban_okrug', 'intraurban_municipality', 'administrative_district', 'source_district', 'region', 'federal']),
  name: text(500, 1), regionId: id.nullable(), sourceEditionId: id, sourceCode: text(100, 1).nullable(),
  geographicStatus: z.enum(['historical_source_snapshot', 'corpus_scope']), geometryId: id.nullable(), sourceRegionId: id.nullable(),
  sourceName: text(500, 1), classificationBasis: z.enum(['source_names_rosstat', 'federal_city_administrative_layer', 'source_label_only', 'corpus_scope']),
  roomEligible: z.boolean(), statistics: statisticsLink,
}).superRefine((value, ctx) => {
  const geometry = value.level === 'municipality' || value.level === 'administrative_district';
  const municipalKinds = ['municipal_district', 'municipal_okrug', 'urban_okrug', 'intraurban_municipality'];
  if ((value.level === 'federal') !== (value.regionId === null)
    || value.roomEligible !== (value.level !== 'administrative_district')
    || (geometry ? value.geometryId === null || value.territoryKey !== `rudn-mun-${value.geometryId}` || value.geographicStatus !== 'historical_source_snapshot'
      : value.geometryId !== null || value.geographicStatus !== 'corpus_scope')
    || (value.level === 'municipality') !== municipalKinds.includes(value.unitKind)
    || (value.statistics.status === 'matched' && value.level !== 'municipality')
    || value.sourceCode !== value.statistics.sourceCode) {
    ctx.addIssue({ code: 'custom', message: 'Несогласованный тип территории или привязка статистики.' });
  }
});

export const territoryRegistrySchema = z.strictObject({
  schemaVersion: z.literal(1), editionId: id, records: z.array(territoryRecordSchema).min(1).max(10000),
}).refine((value) => new Set(value.records.map((record) => record.territoryKey)).size === value.records.length)
  .refine((value) => {
    const regionIds = new Set(value.records.filter((record) => record.level === 'region').map((record) => record.regionId));
    return value.records.every((record) => record.regionId === null || regionIds.has(record.regionId));
  });

const source = z.strictObject({
  id, title: text(500, 1), repository: text(300, 1), commit, sourcePath: text(500, 1), url: httpsUrl, sha256: hash,
  license: text(2000, 1), vintage: text(100, 1).nullable(), provenanceStatus: z.enum(['incomplete_primary', 'owner_supplied_geography', 'corpus_scope']), note: text(3000, 1),
});
const regionManifest = z.strictObject({
  regionId: id, name: text(500, 1), sourceRegionId: id, geographyCount: count.max(1000), municipalityCount: count.max(1000),
  matchedStatisticsCount: count.max(1000), availableSeriesCount: count.max(1000), mapPath: publicPath, mapSha256: hash,
  statisticsPath: publicPath, statisticsSha256: hash,
}).refine((value) => value.mapPath === `/data/territories/regions/${value.regionId}.map.json`
  && value.statisticsPath === `/data/territories/regions/${value.regionId}.statistics.json`
  && value.municipalityCount <= value.geographyCount && value.matchedStatisticsCount <= value.municipalityCount
  && value.availableSeriesCount <= value.matchedStatisticsCount);

export const territoryDataIndexSchema = z.strictObject({
  schemaVersion: z.literal(1), editionId: id, algorithmVersion: id, geographyEditionId: id, statisticsEditionId: id,
  registryPath: z.literal('/data/territories/registry.json'), registrySha256: hash,
  metrics: z.array(municipalMetricDefinitionSchema).length(7), sources: z.array(source).min(1).max(300), regions: z.array(regionManifest).min(1).max(200),
  coverage: z.strictObject({ regions: count, geographicUnits: count, municipalities: count, administrativeUnits: count,
    matchedStatistics: count, availableStatistics: count, unlinkedSourceRows: count, observationYears: z.tuple([year, year]) }),
  warnings: z.array(text(3000, 1)).min(1).max(30),
}).superRefine((value, ctx) => {
  const sum = (field: 'geographyCount' | 'municipalityCount' | 'matchedStatisticsCount' | 'availableSeriesCount') => value.regions.reduce((n, region) => n + region[field], 0);
  if (new Set(value.metrics.map((metric) => metric.id)).size !== 7
    || new Set(value.regions.map((region) => region.regionId)).size !== value.regions.length
    || new Set(value.sources.map((record) => record.id)).size !== value.sources.length
    || value.coverage.regions !== value.regions.length || value.coverage.geographicUnits !== sum('geographyCount')
    || value.coverage.municipalities !== sum('municipalityCount') || value.coverage.matchedStatistics !== sum('matchedStatisticsCount')
    || value.coverage.availableStatistics !== sum('availableSeriesCount')
    || value.coverage.administrativeUnits + value.coverage.municipalities !== value.coverage.geographicUnits
    || value.coverage.observationYears[0] > value.coverage.observationYears[1]) {
    ctx.addIssue({ code: 'custom', message: 'Несогласованные идентификаторы или охват территориального набора.' });
  }
});

const nullableAmount = amount.nullable();
const annualRow = z.tuple([year, nullableAmount, nullableAmount, nullableAmount, nullableAmount, nullableAmount, nullableAmount, nullableAmount]).refine((row) => {
  const [, births, deaths, population, arrivals, departures, migration, natural] = row;
  if ([births, deaths, population, arrivals, departures].some((value) => value !== null && value < 0)
    || [births, deaths, arrivals, departures, migration, natural].some((value) => value !== null && !Number.isInteger(value))) return false;
  if (births === null || deaths === null) { if (natural !== null) return false; }
  else if (natural !== births - deaths) return false;
  return arrivals === null || departures === null || migration === null || migration === arrivals - departures;
});
const annualSeries = z.strictObject({ territoryKey: id, sourceMunicipalityKey: id, rows: z.array(annualRow).min(1).max(201) })
  .refine((value) => value.rows.every((row, i) => i === 0 || row[0] > value.rows[i - 1][0]));

export const regionStatisticsPackSchema = z.strictObject({
  schemaVersion: z.literal(1), editionId: id, statisticsEditionId: id, geographyEditionId: id,
  regionId: id, sourceId: id, provenanceStatus: z.literal('incomplete_primary'), geographyComparability: z.literal('not_verified'),
  columns: z.tuple([z.literal('year'), z.literal('births_total'), z.literal('deaths_total'), z.literal('pop_mid'), z.literal('mig_in_total'), z.literal('mig_out_total'), z.literal('mig_net_total'), z.literal('natural_change')]),
  series: z.array(annualSeries).max(1000),
}).refine((value) => new Set(value.series.map((series) => series.territoryKey)).size === value.series.length
  && new Set(value.series.map((series) => series.sourceMunicipalityKey)).size === value.series.length);

const coordinate = z.number().finite().min(0).max(1200);
const mapShape = z.strictObject({
  territoryKey: id, geometryId: id, path: z.string().min(5).max(4000000).regex(/^[MLZ0-9., -]+$/u),
  bounds: z.tuple([coordinate, coordinate, coordinate, coordinate]), labelPoint: z.tuple([coordinate, coordinate]),
}).refine((value) => value.territoryKey === `rudn-mun-${value.geometryId}` && value.bounds[0] < value.bounds[2] && value.bounds[1] < value.bounds[3]
  && value.bounds[3] <= 800 && value.labelPoint[0] >= value.bounds[0] && value.labelPoint[0] <= value.bounds[2]
  && value.labelPoint[1] >= value.bounds[1] && value.labelPoint[1] <= value.bounds[3]);
export const territoryMapPackSchema = z.strictObject({
  schemaVersion: z.literal(1), editionId: id, geographyEditionId: id, regionId: id,
  viewBox: z.tuple([z.literal(0), z.literal(0), z.literal(1200), z.literal(800)]),
  projection: z.strictObject({ name: z.literal('local-equirectangular-layout'), referenceLatitude: z.number().min(-90).max(90),
    longitudeOrigin: z.number().min(-180).max(180), precisionPixels: z.literal(0.1) }),
  sourceId: id, shapes: z.array(mapShape).min(1).max(1000), note: text(3000, 1),
}).refine((value) => new Set(value.shapes.map((shape) => shape.territoryKey)).size === value.shapes.length);

export const canonicalMunicipalSeriesSchema = z.strictObject({
  id: text(400, 1), territoryKey: id, metricId, title: text(200, 1), unit: z.literal('persons'), semanticType: z.enum(['stock', 'flow']),
  valueDomain: z.enum(['nonnegative', 'signed']), aggregation: z.enum(['sum', 'none']), decimals: z.number().int().min(0).max(1),
  reference: z.enum(['annual_average', 'calendar_year']), sourceEditionId: id, sourceUrl: httpsUrl, sourcePath: text(500, 1),
  sourceSha256: hash, sourceCommit: commit, sourceKind, provenanceStatus: z.literal('incomplete_primary'),
  sourceMunicipalityKey: id, geographyEditionId: id, geographyComparability: z.literal('not_verified'), comparabilityNote: text(5000, 1),
  fingerprint: hash, points: z.array(z.strictObject({ year, value: nullableAmount })).min(1).max(201),
}).refine((value) => sameSemantics({ ...value, id: undefined })
  && value.aggregation === (value.semanticType === 'flow' ? 'sum' : 'none')
  && value.decimals === (value.metricId === 'pop_mid' ? 1 : 0)
  && value.points.some((point) => point.value !== null)
  && value.points.every((point, i) => (i === 0 || point.year > value.points[i - 1].year)
    && (point.value === null || (value.valueDomain === 'signed' || point.value >= 0))
    && (point.value === null || value.metricId === 'pop_mid' || Number.isInteger(point.value))));

function parse<T>(schema: z.ZodType, value: unknown, title: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`Несовместимые данные: ${title}, ${result.error.issues[0]?.path.join('.') || 'структура'}.`);
  return result.data as T;
}
export const parseTerritoryDataIndex = (value: unknown) => parse<TerritoryDataIndex>(territoryDataIndexSchema, value, 'паспорт территорий');
export const parseTerritoryRegistry = (value: unknown) => parse<TerritoryRegistry>(territoryRegistrySchema, value, 'реестр территорий');
export const parseTerritoryMapPack = (value: unknown) => parse<TerritoryMapPack>(territoryMapPackSchema, value, 'карта муниципалитетов');
export const parseRegionStatisticsPack = (value: unknown) => parse<RegionStatisticsPack>(regionStatisticsPackSchema, value, 'муниципальные ряды');
export const parseCanonicalMunicipalSeries = (value: unknown) => parse<CanonicalMunicipalSeries>(canonicalMunicipalSeriesSchema, value, 'канонический ряд');

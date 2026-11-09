/** Source-qualified territory identities; none of these keys is an official current OKTMO. */
export type TerritoryLevel = 'municipality' | 'administrative_district' | 'region' | 'federal';
export type TerritoryUnitKind = 'municipal_district' | 'municipal_okrug' | 'urban_okrug' | 'intraurban_municipality' | 'administrative_district' | 'source_district' | 'region' | 'federal';
export type MunicipalMetricId = 'births_total' | 'deaths_total' | 'pop_mid' | 'mig_in_total' | 'mig_out_total' | 'mig_net_total' | 'natural_change';
export interface MunicipalMetricDefinition {
  id: MunicipalMetricId;
  label: string;
  unit: 'persons';
  kind: 'stock' | 'flow';
  reference: 'annual_average' | 'calendar_year';
  signed: boolean;
  sourceField: string;
  sourceKind: 'source_reported' | 'calculated';
  definition: string;
}
export interface TerritoryStatisticsLink {
  status: 'matched' | 'unmatched' | 'ambiguous' | 'not_applicable';
  sourceMunicipalityKey: string | null;
  sourceCode: string | null;
  sourceNames: string[];
  matchingRule: 'unique_name_and_type_in_region' | null;
  hasSeries: boolean;
  note: string;
}
export interface TerritoryRecord {
  territoryKey: string;
  level: TerritoryLevel;
  unitKind: TerritoryUnitKind;
  name: string;
  regionId: string | null;
  sourceEditionId: string;
  sourceCode: string | null;
  geographicStatus: 'historical_source_snapshot' | 'corpus_scope';
  geometryId: string | null;
  sourceRegionId: string | null;
  sourceName: string;
  classificationBasis: 'source_names_rosstat' | 'federal_city_administrative_layer' | 'source_label_only' | 'corpus_scope';
  roomEligible: boolean;
  statistics: TerritoryStatisticsLink;
}
export interface TerritoryRegistry {
  schemaVersion: 1;
  editionId: string;
  records: TerritoryRecord[];
}
export interface TerritorySource {
  id: string;
  title: string;
  repository: string;
  commit: string;
  sourcePath: string;
  url: string;
  sha256: string;
  license: string;
  vintage: string | null;
  provenanceStatus: 'incomplete_primary' | 'owner_supplied_geography' | 'corpus_scope';
  note: string;
}
export interface TerritoryRegionManifest {
  regionId: string;
  name: string;
  sourceRegionId: string;
  geographyCount: number;
  municipalityCount: number;
  matchedStatisticsCount: number;
  availableSeriesCount: number;
  mapPath: string;
  mapSha256: string;
  statisticsPath: string;
  statisticsSha256: string;
}
export interface TerritoryDataIndex {
  schemaVersion: 1;
  editionId: string;
  algorithmVersion: string;
  geographyEditionId: string;
  statisticsEditionId: string;
  registryPath: string;
  registrySha256: string;
  metrics: MunicipalMetricDefinition[];
  sources: TerritorySource[];
  regions: TerritoryRegionManifest[];
  coverage: {
    regions: number;
    geographicUnits: number;
    municipalities: number;
    administrativeUnits: number;
    matchedStatistics: number;
    availableStatistics: number;
    unlinkedSourceRows: number;
    observationYears: [number, number];
  };
  warnings: string[];
}
export type MunicipalAnnualRow = [number, number | null, number | null, number | null, number | null, number | null, number | null, number | null];
export interface MunicipalAnnualSeries {
  territoryKey: string;
  sourceMunicipalityKey: string;
  rows: MunicipalAnnualRow[];
}
export interface RegionStatisticsPack {
  schemaVersion: 1;
  editionId: string;
  statisticsEditionId: string;
  geographyEditionId: string;
  regionId: string;
  sourceId: string;
  provenanceStatus: 'incomplete_primary';
  geographyComparability: 'not_verified';
  columns: ['year', 'births_total', 'deaths_total', 'pop_mid', 'mig_in_total', 'mig_out_total', 'mig_net_total', 'natural_change'];
  series: MunicipalAnnualSeries[];
}
export interface TerritoryMapShape {
  territoryKey: string;
  geometryId: string;
  path: string;
  bounds: [number, number, number, number];
  labelPoint: [number, number];
}
export interface TerritoryMapPack {
  schemaVersion: 1;
  editionId: string;
  geographyEditionId: string;
  regionId: string;
  viewBox: [number, number, number, number];
  projection: { name: 'local-equirectangular-layout'; referenceLatitude: number; longitudeOrigin: number; precisionPixels: number };
  sourceId: string;
  shapes: TerritoryMapShape[];
  note: string;
}

/** Sealed single-indicator series used by the browser, trusted seed and roadmap snapshots. */
export interface CanonicalMunicipalSeries {
  id: string;
  territoryKey: string;
  metricId: MunicipalMetricId;
  title: string;
  unit: 'persons';
  semanticType: 'stock' | 'flow';
  valueDomain: 'nonnegative' | 'signed';
  aggregation: 'sum' | 'none';
  decimals: number;
  reference: 'annual_average' | 'calendar_year';
  sourceEditionId: string;
  sourceUrl: string;
  sourcePath: string;
  sourceSha256: string;
  sourceCommit: string;
  sourceKind: 'source_reported' | 'calculated';
  provenanceStatus: 'incomplete_primary';
  sourceMunicipalityKey: string;
  geographyEditionId: string;
  geographyComparability: 'not_verified';
  comparabilityNote: string;
  fingerprint: string;
  points: Array<{ year: number; value: number | null }>;
}

/** Stable within one sealed data edition; the database rechecks the canonical points and definition. */
export function territorySeriesId(editionId: string, territoryKey: string, metricId: MunicipalMetricId): string {
  return `${editionId}:${territoryKey}:${metricId}`;
}

import type { CanonicalMunicipalSeries, RegionStatisticsPack, TerritoryDataIndex, TerritoryRegistry } from './types';
export function canonicalSeriesText(series: Omit<CanonicalMunicipalSeries, 'fingerprint'> | CanonicalMunicipalSeries): string;
export function canonicalSeriesFingerprint(series: Omit<CanonicalMunicipalSeries, 'fingerprint'> | CanonicalMunicipalSeries): Promise<string>;
export function verifyCanonicalSeriesFingerprint(series: CanonicalMunicipalSeries): Promise<boolean>;
export function adaptCanonicalSeries(index: TerritoryDataIndex, registry: TerritoryRegistry, pack: RegionStatisticsPack): Promise<CanonicalMunicipalSeries[]>;

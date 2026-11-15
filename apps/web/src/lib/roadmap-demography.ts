import { gunzipSync } from 'fflate';
import { assetUrl } from './corpus';

export type Count = number | null;
export type Residence = 'all' | 'urban' | 'rural';
export type AgeSex = [from: number, to: number | null, men: Count, women: Count];
export type MigrationValues = [arrivals: Count, departures: Count, balance: Count];
export type MigrationAge = [from: number, to: number | null, ...MigrationValues];
export type MigrationDirection = 'all' | 'within_region' | 'interregional' | 'international' |
  'within_russia' | 'outside_region' | 'cis' | 'other_international' | 'urban_destinations';
export type AnnualMetric = 'population_january_all' | 'population_january_urban' | 'population_january_rural' |
  'natural_reported' | 'birth_rate' | 'death_rate' | 'natural_rate';
export interface RoadmapDemography {
  population: Array<[year: number, residence: Residence, total: [Count, Count] | null, rows: AgeSex[]]>;
  migration: Array<[year: number, direction: MigrationDirection, total: MigrationValues | null, rows: MigrationAge[]]>;
  annual: Partial<Record<AnnualMetric, [year: number, value: number][]>>;
}
interface Index {
  schemaVersion: 1;
  registryEditionId: string;
  source: string;
  sourceUrl: string;
  sourceVersion: string;
  regions: { id: string; path: string; sha256: string }[];
}
type Pack = { schemaVersion: 1; regionId: string; territories: Record<string, RoadmapDemography> };

const slug = /^[a-z0-9-]+$/u;
let indexRequest: Promise<Index> | undefined;
const regional = new Map<string, Promise<Pack>>();

async function readIndex(): Promise<Index> {
  const response = await fetch(assetUrl('data/demography/index.json'), { cache: 'no-cache' });
  if (!response.ok) throw new Error('Не удалось загрузить состав данных БДМО.');
  const data = await response.json() as Index;
  if (data.schemaVersion !== 1 || !Array.isArray(data.regions) || typeof data.source !== 'string' ||
      !data.regions.every(entry => slug.test(entry.id) && entry.path === `${entry.id}.json.gz` &&
        /^[a-f0-9]{64}$/u.test(entry.sha256)))
    throw new Error('Состав данных БДМО повреждён.');
  return data;
}

async function readRegion(regionId: string, path: string): Promise<Pack> {
  const response = await fetch(assetUrl(`data/demography/${path}`));
  if (!response.ok) throw new Error('Не удалось загрузить данные БДМО для региона.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 8_000_000) throw new Error('Объём пакета БДМО превышает допустимый.');
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(gunzipSync(bytes));
  const pack = JSON.parse(decoded) as Pack;
  if (pack.schemaVersion !== 1 || pack.regionId !== regionId || !pack.territories)
    throw new Error('Пакет данных БДМО не соответствует выбранному региону.');
  return pack;
}

export async function loadRoadmapDemography(regionId: string | null, territoryKey: string, editionId: string) {
  if (!regionId) return null;
  indexRequest ??= readIndex().catch(error => {
    indexRequest = undefined;
    throw error;
  });
  const index = await indexRequest;
  if (index.registryEditionId !== editionId) return null;
  const entry = index.regions.find(item => item.id === regionId);
  if (!entry) return null;
  let request = regional.get(regionId);
  if (!request) {
    request = readRegion(regionId, `${entry.path}?v=${entry.sha256}`).catch(error => {
      regional.delete(regionId);
      throw error;
    });
    if (regional.size >= 6) {
      const oldest = regional.keys().next().value;
      if (oldest) regional.delete(oldest);
    }
    regional.set(regionId, request);
  }
  const material = (await request).territories[territoryKey];
  return material ? {
    data: material,
    source: index.source,
    sourceVersion: index.sourceVersion,
    sourceUrl: index.sourceUrl,
  } : null;
}

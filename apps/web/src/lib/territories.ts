import type {
  TerritoryDataIndex,
  TerritoryRegistry,
  TerritoryMapPack,
  RegionStatisticsPack,
  CanonicalMunicipalSeries,
} from '../../../../packages/territories/types';
import {
  parseTerritoryDataIndex,
  parseTerritoryRegistry,
  parseTerritoryMapPack,
  parseRegionStatisticsPack,
} from '../../../../packages/territories/schema';
import { adaptCanonicalSeries } from '../../../../packages/territories/series.mjs';
import { assetUrl } from './corpus';

const files = new Map<string, Promise<unknown>>();
async function checkedJson<T>(
  path: string,
  sha256: string | null,
  parse: (raw: unknown) => T,
): Promise<T> {
  if (!/^\/?data\/territories\/[a-zA-Z0-9._/-]+\.json$/u.test(path) || path.includes('..'))
    throw new Error('Некорректный путь территориальных данных.');
  const key = `${path}:${sha256 ?? 'index'}`;
  let pending = files.get(key);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(assetUrl(path));
      if (!response.ok || (response.headers.get('content-type') ?? '').includes('text/html'))
        throw new Error('Территориальные данные не загрузились. Повторите запрос.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > 12 * 1024 * 1024)
        throw new Error('Файл территориальных данных превышает допустимый размер.');
      if (sha256) {
        const digest = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
          (b) => b.toString(16).padStart(2, '0'),
        ).join('');
        if (digest !== sha256)
          throw new Error(
            'Контрольная сумма территориального набора не совпала. Обновите комплект данных целиком.',
          );
      }
      return parse(JSON.parse(new TextDecoder().decode(bytes)));
    })().catch((error: unknown) => {
      files.delete(key);
      throw error;
    });
    files.set(key, pending);
    while (files.size > 14) files.delete(files.keys().next().value!);
  }
  return pending as Promise<T>;
}
export function loadTerritoryIndex() {
  return checkedJson('data/territories/index.json', null, parseTerritoryDataIndex);
}
export async function loadTerritoryRegistry(index: TerritoryDataIndex): Promise<TerritoryRegistry> {
  const result = await checkedJson(
    index.registryPath,
    index.registrySha256,
    parseTerritoryRegistry,
  );
  if (result.editionId !== index.editionId)
    throw new Error('Справочник и манифест относятся к разным редакциям.');
  return result;
}
export async function loadTerritoryMap(
  index: TerritoryDataIndex,
  regionId: string,
): Promise<TerritoryMapPack> {
  const region = index.regions.find((r) => r.regionId === regionId);
  if (!region) throw new Error('Геометрия выбранного региона отсутствует в наборе.');
  const result = await checkedJson(region.mapPath, region.mapSha256, parseTerritoryMapPack);
  if (result.regionId !== regionId || result.geographyEditionId !== index.geographyEditionId)
    throw new Error('Геометрия относится к другой территории или редакции.');
  return result;
}
export async function loadTerritoryStatistics(
  index: TerritoryDataIndex,
  regionId: string,
): Promise<RegionStatisticsPack> {
  const region = index.regions.find((r) => r.regionId === regionId);
  if (!region) throw new Error('Статистика выбранного региона отсутствует в наборе.');
  const result = await checkedJson(
    region.statisticsPath,
    region.statisticsSha256,
    parseRegionStatisticsPack,
  );
  if (result.regionId !== regionId || result.statisticsEditionId !== index.statisticsEditionId)
    throw new Error('Статистика относится к другой территории или редакции.');
  return result;
}
const seriesCache = new Map<string, Promise<CanonicalMunicipalSeries[]>>();
export function loadCanonicalSeries(
  index: TerritoryDataIndex,
  registry: TerritoryRegistry,
  regionId: string,
) {
  const key = `${index.editionId}:${regionId}`;
  let pending = seriesCache.get(key);
  if (!pending) {
    pending = loadTerritoryStatistics(index, regionId)
      .then((pack) => adaptCanonicalSeries(index, registry, pack))
      .catch((error) => {
        seriesCache.delete(key);
        throw error;
      });
    seriesCache.set(key, pending);
    while (seriesCache.size > 6) seriesCache.delete(seriesCache.keys().next().value!);
  }
  return pending;
}
export const territoryKindLabel = {
  municipal_district: 'Муниципальный район',
  municipal_okrug: 'Муниципальный округ',
  urban_okrug: 'Городской округ',
  intraurban_municipality: 'Внутригородское муниципальное образование',
  administrative_district: 'Административный район или округ',
  source_district: 'Район исходного слоя; тип не подтверждён',
  region: 'Субъект Российской Федерации',
  federal: 'Российская Федерация',
} as const;

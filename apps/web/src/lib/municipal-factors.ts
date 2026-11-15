import { gunzipSync } from 'fflate';
import { z } from 'zod';
import { sha256Hex } from '../../../../packages/security/crypto.mjs';
import { assetUrl } from './corpus';

const key = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const year = z.number().int().min(1900).max(2100);
const count = z.number().int().nonnegative();
const coefficient = z.number().min(-1).max(1);
const metric = z.object({ id: count, code: z.string(), title: z.string().min(1), sectionName: z.string(),
  unit: z.string(), period: z.string(), dimensions: z.array(z.tuple([z.string(), z.string().nullable()])) });
const location = z.object({ key, regionId: key, regionName: z.string(), name: z.string(),
  oktmo: z.string().regex(/^\d{8}$/u), munDistrict: z.string().nullable().optional(), nFactors: count,
  path: z.string().regex(/^municipalities\/[a-z0-9_-]+\.json\.gz$/u).nullable(), sha256: hash.nullable(),
}).refine((item) => item.nFactors ? item.path === `municipalities/${item.key}.json.gz` && !!item.sha256 : item.path === null && item.sha256 === null);
const indexSchema = z.object({ schemaVersion: z.literal(1), sourceRelease: z.string(), yearStart: year, yearEnd: year,
  outcome: z.object({ title: z.string(), unit: z.string() }), method: z.object({ minPairs: count }),
  metrics: z.array(metric), territories: z.array(location),
}).refine((item) => item.yearEnd >= item.yearStart && item.yearEnd - item.yearStart < 29 &&
  item.metrics.every((m, i) => m.id === i) && new Set(item.territories.map((t) => t.key)).size === item.territories.length);
const rowSchema = z.tuple([count, count, count, coefficient, coefficient, coefficient, coefficient]);
const packSchema = z.object({ schemaVersion: z.literal(1), key, rows: z.array(rowSchema) });
export type MunicipalityLevel = 'upper' | 'lower';
export type FactorIndex = z.infer<typeof indexSchema> & { level: MunicipalityLevel };
export type FactorMunicipality = z.infer<typeof location>;
export type FactorRow = z.infer<typeof rowSchema>;

async function read(level: MunicipalityLevel, path: string, maxBytes: number, digest?: string) {
  const prefix = level === 'lower' ? 'lower/' : '';
  const response = await fetch(assetUrl(`/data/factors/${prefix}${path}`));
  if (!response.ok || response.headers.get('content-type')?.includes('text/html'))
    throw new Error('Не удалось загрузить муниципальные корреляции.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  const size = bytes.length >= 18 ? new DataView(bytes.buffer).getUint32(bytes.length - 4, true) : 0;
  if (!size || size > maxBytes || bytes.length > maxBytes || (digest && await sha256Hex(bytes) !== digest))
    throw new Error('Файл муниципальных корреляций не прошёл проверку.');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(gunzipSync(bytes))) as unknown;
}

const cachedIndexes: Partial<Record<MunicipalityLevel, Promise<FactorIndex>>> = {};
export function loadFactorIndex(level: MunicipalityLevel) {
  return cachedIndexes[level] ??= read(level, 'index.json.gz', 20_000_000).then((value) => ({
    ...indexSchema.parse(value), level,
  })).catch((error: unknown) => {
    delete cachedIndexes[level];
    throw error;
  });
}

export function observationYears(index: FactorIndex, mask: number) {
  return Array.from({ length: index.yearEnd - index.yearStart + 1 }, (_, i) => index.yearStart + i)
    .filter((_, i) => mask & (1 << i));
}

export async function loadMunicipalFactors(index: FactorIndex, municipality: FactorMunicipality) {
  if (!municipality.path || !municipality.sha256) return [];
  const pack = packSchema.parse(await read(index.level, municipality.path, 4_000_000, municipality.sha256));
  if (pack.key !== municipality.key || pack.rows.length !== municipality.nFactors ||
    new Set(pack.rows.map((r) => r[0])).size !== pack.rows.length ||
    pack.rows.some(([metricId, n, mask, , median, low, high], i) =>
      metricId >= index.metrics.length || n < index.method.minPairs || mask >= 2 ** (index.yearEnd - index.yearStart + 1) ||
      n !== observationYears(index, mask).length || low > median || median > high ||
      (i > 0 && Math.abs(median) > Math.abs(pack.rows[i - 1][4])))) {
    throw new Error('Несогласованные значения муниципальных корреляций.');
  }
  return pack.rows;
}

import { z } from 'zod';
import { sha256Hex } from '../../../../packages/security/crypto.mjs';
import type { CohortInput } from '../../../../packages/analytics/cohort';
import type { CohortForecastParameters } from '../../../../packages/roadmaps/types';
import { assetUrl } from './corpus';

// Shared settings in the first release refer to this exact published model input.
const cohortInputHash = '9639bb7bfedbe993dfb8d4f02ba7cdb3f45525620e2a288626e2f6e2ea8e972b';

const count = z.number().nonnegative();
const ratio = count.max(1);
const ages = z.array(count).length(81);
const migrationBands = z.array(ratio).length(17);
const migration = z.object({ male: migrationBands, female: migrationBands });
const year = z.number().int().min(1900).max(2100);
const bundle = z.object({
  schemaVersion: z.literal(1),
  territories: z.array(z.object({
    territoryKey: z.string().min(1),
    name: z.string().min(1),
    baseYear: year,
    base: z.object({ male: ages, female: ages }),
    fertilityShares: z.array(ratio).length(7),
    sexRatioAtBirth: z.number().positive(),
    migrationProfile: z.object({ arrivals: migration, departures: migration }),
    assumptions: z.array(z.object({
      year,
      fertilityRate: count,
      lifeExpectancy: z.object({ male: z.number().positive(), female: z.number().positive() }),
      arrivalsPerPerson: count,
      departuresPerPerson: count,
    })).min(1),
    history: z.array(z.object({
      year,
      population: count.nullable().optional(),
      births: count.nullable(),
      deaths: count.nullable(),
      arrivals: count.nullable(),
      departures: count.nullable(),
    })).min(5),
    source: z.object({
      summary: z.string().min(1),
      baseDate: z.iso.date(),
      citations: z.array(z.object({ label: z.string().min(1), url: z.url({ protocol: /^https$/ }) })),
      notes: z.array(z.string()),
    }),
  })),
});

export async function loadCohortInput(territoryKey: string, signal?: AbortSignal): Promise<CohortInput | null> {
  if (territoryKey !== 'region:respublika-mordoviia' && !territoryKey.startsWith('rudn-mun-72196-'))
    return null;
  const response = await fetch(assetUrl('data/cohort/mordovia.json'), { signal, cache: 'no-cache' });
  if (!response.ok) throw new Error('Не удалось загрузить исходные данные прогноза.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (await sha256Hex(bytes) !== cohortInputHash) throw new Error('Исходные данные не соответствуют выпуску прогноза. Обновите страницу.');
  const result = bundle.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
  if (!result.success) throw new Error('Исходные данные прогноза не прошли проверку.');
  return result.data.territories.find((item) => item.territoryKey === territoryKey) ?? null;
}

const cohortMultiplier = z.number().min(0).max(3).optional();
const cohortOptionsSchema = z.object({
  endYear: year,
  fertilityMultiplier: cohortMultiplier,
  mortalityMultiplier: cohortMultiplier,
  arrivalsMultiplier: cohortMultiplier,
  departuresMultiplier: cohortMultiplier,
});

function cohortOptionsKey(roadmapId: string) {
  return `dw:cohort-options:1:${roadmapId}`;
}
export function defaultCohortParameters(baseYear: number): CohortForecastParameters {
  return { endYear: Math.min(2050, baseYear + 30), fertilityMultiplier: 1, mortalityMultiplier: 1,
    arrivalsMultiplier: 1, departuresMultiplier: 1 };
}

/** Preserve a browser-only scenario as a draft until its owner explicitly shares it. */
export function readLegacyCohortOptions(roadmapId: string, baseYear: number): CohortForecastParameters | undefined {
  try {
    const input = cohortOptionsSchema.safeParse(JSON.parse(localStorage.getItem(cohortOptionsKey(roadmapId)) ?? 'null'));
    if (input.success && input.data.endYear > baseYear) {
      const data = input.data;
      return { endYear: data.endYear, fertilityMultiplier: data.fertilityMultiplier ?? 1,
        mortalityMultiplier: data.mortalityMultiplier ?? 1, arrivalsMultiplier: data.arrivalsMultiplier ?? 1,
        departuresMultiplier: data.departuresMultiplier ?? 1 };
    }
  } catch { /* The shared calculator also works without browser storage. */ }
  return undefined;
}

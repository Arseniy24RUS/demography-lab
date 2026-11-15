import { z } from 'zod';
import type { CohortInput } from '../../../../packages/analytics/cohort';
import { assetUrl } from './corpus';

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
  const result = bundle.safeParse(await response.json());
  if (!result.success) throw new Error('Исходные данные прогноза не прошли проверку.');
  return result.data.territories.find((item) => item.territoryKey === territoryKey) ?? null;
}

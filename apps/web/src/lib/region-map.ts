import { z } from 'zod';
import { assetUrl } from './corpus';

const coordinate = z.number().finite().min(-100).max(1400);
const schema = z.object({
  schemaVersion: z.literal(1),
  viewBox: z.tuple([z.literal(0), z.literal(0), z.literal(1200), z.literal(620)]),
  projection: z.object({ name: z.string(), standardParallels: z.array(z.number()), centralMeridian: z.number(), centerLatitude: z.number() }),
  source: z.object({ sourceUrl: z.url(), inputSha256: z.string().regex(/^[a-f0-9]{64}$/u), licenseStatus: z.string() }),
  shapes: z.array(z.object({
    regionId: z.string().min(1).max(160), featureId: z.string().max(160), name: z.string().max(200),
    d: z.string().min(1).max(1000000).regex(/^[MLZ0-9.,e+\- ]+$/iu),
    centroid: z.tuple([coordinate, coordinate]),
    bounds: z.tuple([coordinate, coordinate, coordinate, coordinate]),
  })).min(1).max(300),
}).superRefine((data, ctx) => {
  if (new Set(data.shapes.map((shape) => shape.regionId)).size !== data.shapes.length)
    ctx.addIssue({ code: 'custom', message: 'Repeated region identifiers' });
});
export type RegionMapData = z.infer<typeof schema>;
export function parseRegionMap(raw: unknown): RegionMapData {
  const result = schema.safeParse(raw);
  if (!result.success) throw new Error('Не удалось проверить геометрию карты. Список регионов остаётся доступным.');
  return result.data;
}
let pending: Promise<RegionMapData> | null = null;
export function loadRegionMap() {
  return pending ??= fetch(assetUrl('data/regions.map.json')).then(async (response) => {
    if (!response.ok) throw new Error('Карта не загрузилась. Выберите регион в списке или повторите загрузку.');
    return parseRegionMap(await response.json());
  }).catch((error: unknown) => { pending = null; throw error; });
}

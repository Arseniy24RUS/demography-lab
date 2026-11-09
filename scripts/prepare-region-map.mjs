import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { geoArea, geoConicEqualArea, geoPath } from 'd3-geo';

// Reproducible navigation geometry. Source shapes and corpus files remain unchanged.
const root = new URL('../', import.meta.url);
const raw = await readFile(new URL('public/data/regions.geojson', root));
const source = JSON.parse(raw);
const corpus = JSON.parse(await readFile(new URL('public/data/corpus/index.json', root), 'utf8'));
const provenance = JSON.parse(await readFile(new URL('public/data/regions.provenance.json', root), 'utf8'));
const normalize = (name) => name.toLocaleLowerCase('ru').replaceAll('ё', 'е')
  .replace(/город /gu, '').replace(/\([^)]*\)/gu, '').replace(/[^a-zа-я0-9]/gu, '');
const byName = new Map(corpus.documents.map((entry) => [normalize(entry.territory), entry]));
if (byName.size !== corpus.documents.length) throw new Error('Ambiguous normalized corpus names');
const features = structuredClone(source.features);
for (const feature of features) {
  // Normalize EACH ring: the source mixes winding inside the same MultiPolygon.
  // Reversing an entire feature turns correct islands into spherical complements.
  const polygons = feature.geometry.type === 'Polygon'
    ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  for (const polygon of polygons) {
    for (const [index, ring] of polygon.entries()) {
      const complement = geoArea({ type: 'Polygon', coordinates: [ring] }) > 2 * Math.PI;
      if (complement === (index === 0)) ring.reverse();
    }
  }
  if (geoArea(feature) > 2 * Math.PI) throw new Error(`Spherical complement: ${feature.properties.name}`);
}
const collection = { type: 'FeatureCollection', features };
const projection = geoConicEqualArea().parallels([50, 70]).rotate([-100, 0]).center([0, 60])
  .fitExtent([[16, 16], [1184, 604]], collection);
const path = geoPath(projection).digits(2);
const used = new Set();
const shapes = features.map((feature) => {
  const entry = byName.get(normalize(feature.properties.name));
  if (!entry || used.has(entry.regionId)) throw new Error(`Unresolved or duplicate region: ${feature.properties.name}`);
  used.add(entry.regionId);
  const d = path(feature);
  const centroid = path.centroid(feature).map((n) => +n.toFixed(2));
  const bounds = path.bounds(feature).flat().map((n) => +n.toFixed(2));
  if (!d || [...centroid, ...bounds].some((n) => !Number.isFinite(n))) throw new Error(`Invalid shape: ${entry.regionId}`);
  return { regionId: entry.regionId, featureId: String(feature.id), name: entry.territory, d, centroid, bounds };
});
if (used.size !== corpus.documents.length) throw new Error('Incomplete map/corpus correspondence');
const result = {
  schemaVersion: 1, viewBox: [0, 0, 1200, 620],
  projection: { name: 'Albers equal-area conic', standardParallels: [50, 70], centralMeridian: 100, centerLatitude: 60 },
  source: { ...provenance, inputSha256: createHash('sha256').update(raw).digest('hex'),
    mapping: 'Exact normalized names; explicit one-to-one correspondence with the frozen corpus. Not official territorial codes.',
    purpose: 'Navigation and declared work allocation; no demographic values or area statistics.' },
  shapes,
};
const output = new URL('public/data/regions.map.json', root);
await writeFile(output, JSON.stringify(result));
console.log(JSON.stringify({ file: fileURLToPath(output), regions: shapes.length, projection: result.projection }));

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseRegionMap } from '../../apps/web/src/lib/region-map';

const data = JSON.parse(readFileSync(new URL('../../public/data/regions.map.json', import.meta.url), 'utf8'));
const corpus = JSON.parse(readFileSync(new URL('../../public/data/corpus/index.json', import.meta.url), 'utf8'));

describe('published navigation geometry', () => {
  it('has an exact one-to-one relationship with the frozen 89-passport corpus', () => {
    const map = parseRegionMap(data);
    expect(map.shapes).toHaveLength(89);
    expect(map.shapes.map((shape) => shape.regionId).sort()).toEqual(corpus.documents.map((document: { regionId: string }) => document.regionId).sort());
    const raw = readFileSync(new URL('../../public/data/regions.geojson', import.meta.url));
    expect(map.source.inputSha256).toBe(createHash('sha256').update(raw).digest('hex'));
  });

  it('does not turn mixed-winding islands of Moscow or Chuvashia into spherical complements', () => {
    const map = parseRegionMap(data);
    const boundsArea = (name: string) => {
      const shape = map.shapes.find((item) => item.name.includes(name));
      expect(shape, name).toBeDefined();
      const [left, top, right, bottom] = shape!.bounds;
      return (right - left) * (bottom - top);
    };
    const yakutia = boundsArea('Якутия');
    expect(yakutia).toBeGreaterThan(80_000);
    expect(boundsArea('Москва') / yakutia).toBeLessThan(0.01);
    expect(boundsArea('Чуваш') / yakutia).toBeLessThan(0.02);
    expect(boundsArea('Москва')).toBeGreaterThan(10);
  });

  it('places all contours inside the intended fit and preserves finite navigation targets', () => {
    const map = parseRegionMap(data);
    for (const shape of map.shapes) {
      const [left, top, right, bottom] = shape.bounds;
      expect(left, shape.name).toBeGreaterThanOrEqual(15.9);
      expect(right, shape.name).toBeLessThanOrEqual(1184.1);
      expect(top, shape.name).toBeGreaterThanOrEqual(15.9);
      expect(bottom, shape.name).toBeLessThanOrEqual(604.1);
      expect(right).toBeGreaterThan(left);
      expect(bottom).toBeGreaterThan(top);
      expect(shape.centroid.every(Number.isFinite)).toBe(true);
    }
  });

  it('rejects duplicate corpus identities and executable content in an SVG path', () => {
    const repeated = structuredClone(data);
    repeated.shapes.push(repeated.shapes[0]);
    expect(() => parseRegionMap(repeated)).toThrow();
    const injected = structuredClone(data);
    injected.shapes[0].d = '<script>alert(1)</script>';
    expect(() => parseRegionMap(injected)).toThrow();
  });
});

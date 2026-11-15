import type { TerritoryMapPack, TerritoryRecord } from '../../../../../packages/territories/types';

export interface TerritoryLabel {
  key: string;
  text: string;
  x: number;
  y: number;
  fontSize: number;
  selected: boolean;
  leader: [number, number] | null;
}
const offsets = [
  [0, 0], [0, -1.2], [0, 1.2], [-1.6, 0], [1.6, 0], [-1.6, -1.2], [1.6, -1.2],
  [-1.6, 1.2], [1.6, 1.2], [0, -2.4], [0, 2.4], [-3.2, 0], [3.2, 0], [-3.2, -1.2],
  [3.2, -1.2], [-3.2, 1.2], [3.2, 1.2], [-1.6, -2.4], [1.6, -2.4], [-1.6, 2.4], [1.6, 2.4],
];
const widerOffsets = Array.from({ length: 17 }, (_, x) => x - 8)
  .flatMap((x) => Array.from({ length: 17 }, (_, y) => [x * 1.6, (y - 8) * 1.2]))
  .filter(([x, y]) => Math.abs(x) >= 3.2 || Math.abs(y) >= 2.4)
  .sort(([x1, y1], [x2, y2]) => Math.hypot(x1, y1) - Math.hypot(x2, y2));
const mediumOffsets = widerOffsets.filter(([x, y]) => Math.abs(x) <= 8 && Math.abs(y) <= 6);

/** Keep labels at readable screen sizes and find room near each shape's label point. */
export function layoutTerritoryLabels(
  map: TerritoryMapPack,
  records: ReadonlyMap<string, TerritoryRecord>,
  selectedKey: string | null,
  workingKeys: ReadonlySet<string>,
  pixelsPerUnit: number,
  screenWidth: number,
): TerritoryLabel[] {
  if (!(pixelsPerUnit > 0)) return [];
  const [left, top, width, height] = map.viewBox;
  const candidates = map.shapes
    .flatMap((shape) => {
      const record = records.get(shape.territoryKey);
      if (!record) return [];
      const selected = record.territoryKey === selectedKey,
        working = workingKeys.has(record.territoryKey);
      return [{ shape, record, selected, priority: selected ? 0 : working ? 1 : 2 }];
    })
    .sort((a, b) => a.priority - b.priority || a.record.name.localeCompare(b.record.name, 'ru'));
  const boxes: Array<[number, number, number, number]> = [];
  const labels: TerritoryLabel[] = [];
  const preferred = screenWidth >= 480 ? 12 : 10;

  function place(candidate: (typeof candidates)[number], positions: number[][], fontSizes: number[]) {
    const original = candidate.record.name;
    const text = original.replace(/(?:^|\s)(?:городской округ|муниципальный район|муниципальный округ)(?=\s|$)/giu, ' ')
      .trim() || original;
    const [anchorX, anchorY] = candidate.shape.labelPoint;
    const emWidth = [...text].reduce((total, char) => total + (/\s|[!:.,иі]/iu.test(char) ? .35 : /[МШЩЖЮ]/iu.test(char) ? .86 : .58), 0);
    for (const screenFontSize of fontSizes) {
      const fontSize = screenFontSize / pixelsPerUnit;
      const halfWidth = (emWidth * screenFontSize / 2 + 2.5) / pixelsPerUnit;
      const halfHeight = (screenFontSize * .57 + 2) / pixelsPerUnit;
      for (const [dx, dy] of positions) {
        const x = Math.max(left + halfWidth, Math.min(left + width - halfWidth, anchorX + dx * fontSize));
        const y = Math.max(top + halfHeight, Math.min(top + height - halfHeight, anchorY + dy * fontSize));
        const box: [number, number, number, number] = [
          x - halfWidth, y - halfHeight, x + halfWidth, y + halfHeight,
        ];
        if (boxes.some(([x1, y1, x2, y2]) => box[0] < x2 && box[2] > x1 && box[1] < y2 && box[3] > y1))
          continue;
        boxes.push(box);
        labels.push({
          key: candidate.record.territoryKey, text, x, y, fontSize, selected: candidate.selected,
          leader: Math.hypot(x - anchorX, y - anchorY) * pixelsPerUnit > 9 ? [anchorX, anchorY] : null,
        });
        return true;
      }
    }
    return false;
  }

  const unplaced = candidates.filter((candidate) => !place(candidate, offsets,
    candidate.selected ? [preferred + 1, preferred] : [preferred, preferred - 1]));
  if (screenWidth >= 480) {
    const positions = screenWidth >= 640 ? widerOffsets : mediumOffsets;
    for (const candidate of unplaced) place(candidate, positions, [preferred - 1, preferred - 2]);
  }

  return labels;
}

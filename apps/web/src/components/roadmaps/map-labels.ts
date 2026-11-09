import type { TerritoryMapPack, TerritoryRecord } from '../../../../../packages/territories/types';

export interface TerritoryLabel {
  key: string;
  text: string;
  x: number;
  y: number;
  fontSize: number;
  selected: boolean;
}
/** Screen-sized labels are decluttered; the full accessible territory list is never filtered. */
export function layoutTerritoryLabels(
  map: TerritoryMapPack,
  records: Map<string, TerritoryRecord>,
  selectedKey: string | null,
  workingKeys: Set<string>,
  zoom: number,
): TerritoryLabel[] {
  const candidates = map.shapes
    .flatMap((shape) => {
      const record = records.get(shape.territoryKey);
      if (!record) return [];
      const selected = record.territoryKey === selectedKey,
        working = workingKeys.has(record.territoryKey);
      if (map.shapes.length > 60 && !selected && !working && zoom < 2) return [];
      return [{ shape, record, selected, priority: selected ? 0 : working ? 1 : 2 }];
    })
    .sort((a, b) => a.priority - b.priority || a.record.name.localeCompare(b.record.name, 'ru'));
  const boxes: Array<[number, number, number, number]> = [],
    labels: TerritoryLabel[] = [];
  for (const candidate of candidates) {
    const text = candidate.record.name
      .replace(/^Городской округ\s+/iu, '')
      .replace(/муниципальный район/iu, '')
      .replace(/муниципальный округ/iu, '')
      .trim();
    const fontSize = 15 / zoom,
      width = [...text].length * fontSize * 0.67,
      padding = 7 / zoom;
    const [x, y] = candidate.shape.labelPoint;
    const box: [number, number, number, number] = [
      x - width / 2 - padding,
      y - fontSize - padding,
      x + width / 2 + padding,
      y + fontSize * 0.3 + padding,
    ];
    if (
      !candidate.selected &&
      (box[0] < 0 ||
        box[2] > map.viewBox[2] ||
        boxes.some(
          (other) =>
            box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1],
        ))
    )
      continue;
    boxes.push(box);
    labels.push({
      key: candidate.record.territoryKey,
      text,
      x,
      y,
      fontSize,
      selected: candidate.selected,
    });
  }
  return labels;
}

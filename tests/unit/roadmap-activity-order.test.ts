import { describe, expect, it } from 'vitest';
import { compareRoadmapActivities } from '../../packages/roadmaps/order';
import type { FrozenRoadmapItem } from '../../packages/roadmaps/types';

describe('the teaching plan reads in calendar order', () => {
  it('puts preparation before the pilot, expansion and final review without rewriting stored order', async () => {
    const module = await import(/* @vite-ignore */ new URL('../../scripts/maintenance/saransk-example.mjs', import.meta.url).href) as {
      buildSaranskExample(): Promise<{ items: FrozenRoadmapItem[] }>;
    };
    const template = await module.buildSaranskExample();
    const activities = template.items.filter((item): item is FrozenRoadmapItem<'activity'> => item.kind === 'activity').reverse();
    const savedOrder = activities.map((item: { id: string }) => item.id);
    const chronological = [...activities].sort(compareRoadmapActivities);
    expect(chronological[0].data.title).toBe('Проверить исходные данные и согласовать устройство пилота');
    expect(chronological.at(-1)!.data.title).toBe('Подготовить итоговую оценку и передачу результатов');
    const starts = chronological.map(item => item.data.startDate);
    expect(starts).toEqual([...starts].sort());
    expect(activities.map((item: { id: string }) => item.id)).toEqual(savedOrder);
    const undated = { ...chronological[0], id: 'undated', data: { ...chronological[0].data, startDate: null, endDate: null } };
    expect([...chronological, undated].sort(compareRoadmapActivities).at(-1)).toBe(undated);
  });
});

import { describe, expect, it } from 'vitest';
import { collectBarrierTopics, type PublicBarrierText } from './topic-cloud';

describe('public barrier topic vocabulary', () => {
  it('counts distinct active cards, preserves negation, and never invents semantic equivalence', () => {
    const cards: PublicBarrierText[] = [
      { id: 'a', title: 'Жильё и работа', description: 'Жилье, жильё. Работа нужна.', status: 'active' },
      { id: 'b', title: 'ЖИЛЬЕ', description: 'Работы. Нет своего жилья.', status: 'active' },
      { id: 'a', title: 'Жильё и работа', description: 'Жилье, жильё. Работа нужна.', status: 'active' },
      { id: 'c', title: 'Жильё', description: null, status: 'archived' },
      { id: 'd', title: null, description: null, status: 'active' },
    ];
    const topics = collectBarrierTopics(cards);
    expect(topics.find((topic) => topic.key === 'жилье')).toMatchObject({ count: 2, barrierIds: ['a', 'b'] });
    expect(topics.find((topic) => topic.key === 'работа')?.count).toBe(1);
    expect(topics.find((topic) => topic.key === 'работы')?.count).toBe(1);
    expect(topics.find((topic) => topic.key === 'нет жилья')?.count).toBe(1);
    expect(topics.some((topic) => ['нужна', 'своего', 'жилья'].includes(topic.key))).toBe(false);
    expect(collectBarrierTopics([...cards].reverse())).toEqual(topics);
    expect(collectBarrierTopics(cards, 1)).toEqual(topics.slice(0, 1));
    expect(collectBarrierTopics([])).toEqual([]);
    expect(collectBarrierTopics(null)).toEqual([]);
  });
});

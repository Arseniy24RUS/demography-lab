import { useId, useMemo, useState, type CSSProperties } from 'react';
import { MessageSquareText, X } from 'lucide-react';
import type { ProjectionBarrier } from '../../../../../packages/barriers/types';
import { collectBarrierTopics } from '../../../../../packages/barriers/topic-cloud';
import './topic-cloud.css';

type TopicCard = Pick<ProjectionBarrier, 'id' | 'title' | 'description' | 'status'>;
const cardsLabel = (count: number) => count % 10 === 1 && count % 100 !== 11 ? 'карточка'
  : count % 10 >= 2 && count % 10 <= 4 && !(count % 100 >= 12 && count % 100 <= 14)
    ? 'карточки' : 'карточек';
const colorFor = (key: string) => [...key].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 4;

/** Accepts only public card text, never a survey response or an account identifier. */
export function BarrierTopicCloud({ barriers }: { barriers: readonly TopicCard[] }) {
  const id = useId();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const topics = useMemo(() => collectBarrierTopics(barriers), [barriers]);
  const selected = topics.find((topic) => topic.key === selectedKey) ?? null;
  const active = barriers.filter((card) => card.status === 'active');
  const selectedIds = new Set(selected?.barrierIds ?? []);
  const selectedCards = active.filter((card) => selectedIds.has(card.id));
  const maximum = topics[0]?.count ?? 1;

  return (
    <section className="topic-cloud" aria-labelledby={`${id}-heading`}>
      <header className="topic-cloud-heading">
        <div>
          <h2 id={`${id}-heading`}><MessageSquareText size={25} strokeWidth={1.7} aria-hidden="true" /> Темы общей доски</h2>
          <p id={`${id}-meaning`}>Размер и число показывают, в скольких карточках встречается формулировка.</p>
        </div>
        <span className="topic-cloud-total">{active.length} {cardsLabel(active.length)}</span>
      </header>

      {topics.length ? (
        <div className="topic-cloud-field" role="group" aria-label="Слова и формулировки барьеров"
          aria-describedby={`${id}-meaning`}>
          {topics.map((topic) => (
            <button type="button" key={topic.key}
              className="topic-cloud-word" data-tone={colorFor(topic.key)}
              style={{ '--topic-weight': Math.sqrt(topic.count / maximum) } as CSSProperties}
              aria-label={`${topic.label}: ${topic.count} ${cardsLabel(topic.count)}`}
              aria-pressed={selected?.key === topic.key}
              aria-controls={`${id}-details`}
              onClick={() => setSelectedKey(selected?.key === topic.key ? null : topic.key)}>
              <span>{topic.label}</span><sup aria-hidden="true">{topic.count}</sup>
            </button>
          ))}
        </div>
      ) : (
        <div className="topic-cloud-empty">
          <MessageSquareText size={38} strokeWidth={1.4} aria-hidden="true" />
          <p>Пока нет барьеров</p>
        </div>
      )}

      <div id={`${id}-details`}>
        {selected ? (
          <section className="topic-cloud-details" aria-labelledby={`${id}-selected`}>
            <header>
              <div><h3 id={`${id}-selected`}>{selected.label}</h3>
                <p>{selected.count} {cardsLabel(selected.count)}</p></div>
              <button type="button" className="icon-button" aria-label="Сбросить выбранную тему"
                onClick={() => setSelectedKey(null)}><X size={19} aria-hidden="true" /></button>
            </header>
            <div className="topic-cloud-cards">
              {selectedCards.map((card) => (
                <article key={card.id}>
                  <h4>{card.title}</h4>
                  {card.description ? <p>{card.description}</p> : null}
                </article>
              ))}
            </div>
          </section>
        ) : null}
      </div>
      {topics.length ? (
        <details className="topic-cloud-method">
          <summary>Как считаются темы</summary>
          <p>Учитываются слова из названий и описаний открытых карточек. Повторы внутри одной карточки
            считаются один раз. Регистр и «ё/е» не различаются; разные формы слов и синонимы автоматически
            не объединяются. Исходные ответы анонимного опроса в облако не включаются.</p>
        </details>
      ) : null}
    </section>
  );
}

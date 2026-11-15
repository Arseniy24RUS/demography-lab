import { useState, type CSSProperties } from 'react';
import { Pause, Play } from 'lucide-react';
import './subjective-cloud.css';

const prompts = [
  ['выплата в 10 млн ₽', 'ежемесячные выплаты', 'condition', 3],
  ['большие траты на детей', 'негде оставить ребёнка', 'barrier', 2],
  ['семейный автомобиль', 'помощь друзей', 'condition', 1],
  ['санкции', 'политическая нестабильность', 'barrier', 1],
  ['доступная ипотека', 'большая зарплата', 'condition', 3],
  ['неуверенность в партнёре', 'нет времени на себя', 'barrier', 2],
  ['дом', 'гибкий график', 'condition', 2],
  ['СВО', 'нестабильная работа', 'barrier', 1],
  ['квартира', 'поддержка близких', 'condition', 2],
  ['разрушение института семьи', 'позднее знакомство', 'barrier', 1],
  ['ЭКО', 'детский сад рядом с домом', 'condition', 3],
  ['страх потерять работу', 'не хочется менять образ жизни', 'barrier', 2],
  ['отпуск для обоих родителей', 'больше свободного времени', 'condition', 1],
  ['дорогое жильё', 'сложности со здоровьем', 'barrier', 2],
  ['помощь с поиском работы', 'уверенность в завтрашнем дне', 'condition', 1],
  ['одиночество', 'сложно совмещать работу и семью', 'barrier', 2],
] as const;

export function SubjectiveTagCloud() {
  const [paused, setPaused] = useState(false);
  return (
    <section className="subjective-cloud" aria-label="Облако идей для старта" data-paused={paused}>
      <div className="subjective-cloud-heading">
        <p>Запишите любую свою мысль о том, что мешает или могло бы помочь.</p>
        <button type="button" className="icon-button subjective-cloud-pause" aria-pressed={paused}
          aria-label={paused ? 'Продолжить анимацию' : 'Приостановить анимацию'}
          title={paused ? 'Продолжить анимацию' : 'Приостановить анимацию'}
          onClick={() => setPaused(value => !value)}>
          {paused ? <Play size={17} aria-hidden /> : <Pause size={17} aria-hidden />}
        </button>
      </div>
      <p className="flipchart-sr-only">
        Примеры для старта. Семейный автомобиль, доступная ипотека, ЭКО, большие траты на детей, неуверенность в партнёре.
      </p>
      <div className="subjective-cloud-words" aria-hidden="true">
        {prompts.map(([first, second, kind, size], i) =>
          <span key={first} data-kind={kind} data-size={size} style={{ '--cloud-phase': `-${i % 8 * 1.75}s` } as CSSProperties}>
            <span>{first}</span><span>{second}</span>
          </span>
        )}
      </div>
    </section>
  );
}

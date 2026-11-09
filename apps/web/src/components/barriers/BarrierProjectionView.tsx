import { useEffect, useState } from 'react';
import { Modal } from '@/components/Modal';
import { ArrowLeft, ArrowRight, GitBranch, Lightbulb, Route } from 'lucide-react';
import type { LifeStage } from '../../../../../packages/barriers/types';
import type { BarrierProjectionViewProps } from './barriers-ui';
import {
  Empty,
  evidenceLabels,
  lifeStages,
  relationshipLabels,
  stageLabels,
  StageChips,
} from './common';
import '../../barriers.css';

export function BarrierProjectionView({ snapshot, mode }: BarrierProjectionViewProps) {
  const [localMode, setLocalMode] = useState<'path' | 'links' | 'solutions'>('path');
  const [stage, setStage] = useState<LifeStage | 'all'>('all');
  const [page, setPage] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 1536 : window.innerWidth,
  );
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const currentMode = mode ?? localMode;
  const barriers = snapshot.barriers.filter(
    (card) => card.status === 'active' && (stage === 'all' || card.stageIds.includes(stage)),
  );
  const links = snapshot.links.filter(
    (link) => link.status === 'active' && barriers.some((card) => card.id === link.barrierId),
  );
  const solutions = snapshot.solutions.filter(
    (card) =>
      card.status === 'active' &&
      (stage === 'all' ||
        card.barrierIds.some((id) => barriers.some((barrier) => barrier.id === id))),
  );
  const count =
    currentMode === 'solutions'
      ? solutions.length
      : currentMode === 'links'
        ? links.length
        : barriers.length;
  // A projector page shows one row of cards, or two relationship explanations.
  // Narrow layouts page through the same records without shrinking their text.
  const limit =
    currentMode === 'links'
      ? viewportWidth > 900
        ? 2
        : 1
      : viewportWidth > 1200
        ? 3
        : viewportWidth > 620
          ? 2
          : 1;
  const safePage = Math.min(page, Math.max(0, Math.ceil(count / limit) - 1));
  const titles = {
    path: 'Барьеры на пути родительства',
    links: 'От барьеров к практикам',
    solutions: 'Авторские гипотезы решений',
  };
  return (
    <section className="barrier-projection">
      <header className="barrier-projection-heading">
        <div>
          <span className="barrier-eyebrow">Совместное обсуждение</span>
          <h1>{titles[currentMode]}</h1>
          <p>Результат работы аудитории · обновляется вместе с доской</p>
        </div>
        {snapshot.survey ? (
          <div className="barrier-projection-survey">
            <span>Опрос</span>
            <strong>
              {snapshot.survey.responseCount === null
                ? 'Число ответов скрыто'
                : `${snapshot.survey.responseCount} ответов`}
            </strong>
            <small>
              {snapshot.survey.responseCount === null
                ? 'Показывается от 5 анкет'
                : 'Без открытых ответов'}
            </small>
          </div>
        ) : null}
      </header>
      {!mode ? (
        <div className="barrier-projection-tabs" role="group" aria-label="Вид результатов">
          <button
            className="button button-secondary"
            aria-pressed={currentMode === 'path'}
            onClick={() => {
              setLocalMode('path');
              setPage(0);
            }}
          >
            <Route size={18} />
            Барьеры
          </button>
          <button
            className="button button-secondary"
            aria-pressed={currentMode === 'links'}
            onClick={() => {
              setLocalMode('links');
              setPage(0);
            }}
          >
            <GitBranch size={18} />
            Связи
          </button>
          <button
            className="button button-secondary"
            aria-pressed={currentMode === 'solutions'}
            onClick={() => {
              setLocalMode('solutions');
              setPage(0);
            }}
          >
            <Lightbulb size={18} />
            Решения
          </button>
        </div>
      ) : null}
      <div
        className="barrier-projection-stages"
        role="group"
        aria-label="Фильтр результатов по этапу"
      >
        <button
          aria-pressed={stage === 'all'}
          onClick={() => {
            setStage('all');
            setPage(0);
          }}
        >
          Все этапы
        </button>
        {lifeStages.map((item) => (
          <button
            key={item}
            aria-pressed={stage === item}
            onClick={() => {
              setStage(item);
              setPage(0);
            }}
          >
            {stageLabels[item]}
            <span>
              {
                snapshot.barriers.filter(
                  (card) => card.status === 'active' && card.stageIds.includes(item),
                ).length
              }
            </span>
          </button>
        ))}
      </div>
      {!count ? (
        <Empty title="Пока нет результатов для этого вида">
          Карточки и связи появятся здесь после сохранения участниками.
        </Empty>
      ) : currentMode === 'path' ? (
        <div className="barrier-projection-cards">
          {barriers.slice(safePage * limit, (safePage + 1) * limit).map((card) => (
            <article
              key={card.id}
              className={`barrier-projection-card${card.priority ? ' is-priority' : ''}`}
            >
              <div className="barrier-card-overline">
                <span>{evidenceLabels[card.evidenceKind]}</span>
                {card.priority ? <span>Для обсуждения</span> : null}
              </div>
              <ProjectionTitle text={card.title} />
              <ProjectionText
                text={card.description}
                label={`Полный текст барьера «${card.title}»`}
              />
              <StageChips stageIds={card.stageIds} primaryStage={card.primaryStage} />
              {card.authorName ? <p className="barrier-byline">{card.authorName}</p> : null}
              <footer>
                <span>
                  Значим: <strong>{card.totals.support}</strong>
                </span>
                <span>
                  Не приоритетен: <strong>{card.totals.oppose}</strong>
                </span>
                <span>
                  Не могу оценить: <strong>{card.totals.neutral}</strong>
                </span>
              </footer>
            </article>
          ))}
        </div>
      ) : currentMode === 'links' ? (
        <div className="barrier-projection-links">
          {links.slice(safePage * limit, (safePage + 1) * limit).map((link) => (
            <article
              key={link.id}
              className={`barrier-projection-link${link.staleReasons.length ? ' stale' : ''}`}
            >
              <div>
                <span>Барьер</span>
                <ProjectionTitle
                  text={
                    barriers.find((card) => card.id === link.barrierId)?.title ??
                    'Барьер недоступен'
                  }
                />
              </div>
              <div className="barrier-projection-link-middle">
                <svg viewBox="0 0 120 35" aria-hidden="true">
                  <path d="M 2 18 C 38 18, 82 18, 118 18" />
                  <circle cx="3" cy="18" r="3" />
                  <circle cx="117" cy="18" r="3" />
                </svg>
                <strong>
                  {link.staleReasons.length
                    ? 'Требует проверки'
                    : relationshipLabels[link.relationship]}
                </strong>
              </div>
              <div>
                <span>Семейство практик</span>
                <ProjectionTitle text={link.familyTitle} />
              </div>
              <div className="barrier-projection-mechanism">
                <ProjectionText
                  text={link.explanation}
                  label="Полное объяснение связи"
                  limit={260}
                />
              </div>
              {link.staleReasons.length ? (
                <p className="barrier-projection-stale-note">
                  Не включается в актуальные связи до проверки новой редакции.
                </p>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <div className="barrier-projection-cards">
          {solutions.slice(safePage * limit, (safePage + 1) * limit).map((card) => (
            <article key={card.id} className="barrier-projection-card">
              <div className="barrier-card-overline">
                <span>Гипотеза</span>
                {card.authorName ? <span>{card.authorName}</span> : null}
              </div>
              <ProjectionTitle text={card.title} />
              <ProjectionText text={card.mechanism} label={`Механизм решения «${card.title}»`} />
              <div className="barrier-solution-first">
                <span>Первый шаг</span>
                <ProjectionText text={card.firstStep} label="Первый шаг решения" limit={180} />
              </div>
              <strong>Проверим:</strong>
              <ProjectionText
                text={card.successIndicator}
                label="Проверяемый результат решения"
                limit={170}
              />
            </article>
          ))}
        </div>
      )}
      <footer className="barrier-projection-footer">
        <p>
          {currentMode === 'links'
            ? 'Связи описывают предполагаемый механизм, а не доказанный демографический эффект.'
            : currentMode === 'path'
              ? 'Этапы — схема обсуждения. Оценки выражают приоритеты участников этой аудитории.'
              : 'Авторские предложения требуют проверки условий, ресурсов и ожидаемого результата.'}
        </p>
        <div className="barrier-pager">
          <button
            className="icon-button"
            aria-label="Предыдущие результаты"
            disabled={safePage === 0}
            onClick={() => setPage(safePage - 1)}
          >
            <ArrowLeft size={19} />
          </button>
          <span>
            {count
              ? `${safePage * limit + 1}–${Math.min(count, (safePage + 1) * limit)} из ${count}`
              : 'Нет карточек'}
          </span>
          <button
            className="icon-button"
            aria-label="Следующие результаты"
            disabled={(safePage + 1) * limit >= count}
            onClick={() => setPage(safePage + 1)}
          >
            <ArrowRight size={19} />
          </button>
        </div>
      </footer>
    </section>
  );
}

function ProjectionText({
  text,
  label,
  limit = 260,
}: {
  text: string;
  label: string;
  limit?: number;
}) {
  const [open, setOpen] = useState(false);
  const chars = Array.from(text);
  const long = chars.length > limit;
  return (
    <div className="barrier-projection-text">
      <p>{long ? `${chars.slice(0, limit).join('')}…` : text}</p>
      {long ? (
        <button className="button button-quiet" aria-label={label} onClick={() => setOpen(true)}>
          Показать полностью
        </button>
      ) : null}
      {open ? (
        <Modal title={label} onClose={() => setOpen(false)} wide>
          <p className="barrier-projection-full-text">{text}</p>
        </Modal>
      ) : null}
    </div>
  );
}
function ProjectionTitle({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const chars = Array.from(text);
  const long = chars.length > 140;
  return (
    <>
      <h2>{long ? `${chars.slice(0, 140).join('')}…` : text}</h2>
      {long ? (
        <button className="button button-quiet" onClick={() => setOpen(true)}>
          Полное название
        </button>
      ) : null}
      {open ? (
        <Modal title="Полное название" onClose={() => setOpen(false)}>
          <p className="barrier-projection-full-text">{text}</p>
        </Modal>
      ) : null}
    </>
  );
}

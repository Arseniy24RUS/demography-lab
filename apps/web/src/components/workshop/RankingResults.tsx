import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type {
  ProjectionFrozenFamily,
  ProjectionVotingRound,
  VotingRound,
} from '../../../../../packages/workshop/types';
import { percentLabel } from './workshop-ui';

type RankedFamily = ProjectionFrozenFamily;

export function RankingResults({
  round,
  projector = false,
  onInspectFamily,
}: {
  round: VotingRound | ProjectionVotingRound;
  projector?: boolean;
  onInspectFamily?: (family: RankedFamily) => void;
}) {
  const [page, setPage] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === 'undefined' ? 900 : window.innerHeight,
  );
  useEffect(() => {
    if (!projector) return;
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [projector]);
  const qualified = round.families
    .filter((family) => family.totals?.qualifies)
    .slice()
    .sort(
      (a, b) =>
        (b.totals?.net ?? -2) - (a.totals?.net ?? -2) || a.title.localeCompare(b.title, 'ru'),
    );
  const insufficient = round.families
    .filter((family) => !family.totals?.qualifies)
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  // Reserve space for the session, frozen question, method and page controls.
  const pageSize = projector
    ? Math.max(1, Math.min(5, Math.floor((viewportHeight - 610) / 150)))
    : qualified.length || 1;
  const pageCount = Math.max(1, Math.ceil(qualified.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visible = qualified.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const ranks = new Map<string, number>();
  let previousNet: number | null | undefined;
  let rank = 0;
  qualified.forEach((family, index) => {
    if (family.totals?.net !== previousNet) rank = index + 1;
    previousNet = family.totals?.net;
    ranks.set(family.id, rank);
  });

  if (!round.totalsVisible) {
    return (
      <div className="workshop-empty">
        <h3>Итоги откроются после завершения раунда</h3>
        <p>До раскрытия участники видят собственные оценки и общий ход участия.</p>
      </div>
    );
  }

  function breakdown(family: RankedFamily) {
    const totals = family.totals;
    if (!totals) return null;
    return (
      <dl className="workshop-vote-breakdown">
        <div>
          <dt>Поддержали</dt>
          <dd>{totals.support}</dd>
        </div>
        <div>
          <dt>Не поддержали</dt>
          <dd>{totals.oppose}</dd>
        </div>
        <div>
          <dt>Не смогли оценить</dt>
          <dd>{totals.neutral}</dd>
        </div>
        <div>
          <dt>Ответили</dt>
          <dd>
            {totals.cast}/{round.eligibleCount}
          </dd>
        </div>
        <div>
          <dt>Нет ответа</dt>
          <dd>{totals.unanswered}</dd>
        </div>
      </dl>
    );
  }

  return (
    <section
      className={`workshop-ranking${projector ? ' workshop-ranking-projector' : ''}`}
      aria-label="Результаты оценивания семейств"
    >
      <div className="workshop-ranking-heading">
        <div>
          <h3>Оценка участников сессии</h3>
          <p>
            {round.status === 'open'
              ? 'Промежуточные итоги открытого раунда'
              : 'Зафиксированные итоги раунда'}
          </p>
        </div>
        <span className="workshop-ranking-rule">
          Охват ≥ {percentLabel(round.minCoverage)} · содержательных оценок ≥{' '}
          {round.minSubstantiveVotes}
        </span>
      </div>
      <p className="workshop-method-note">
        Приоритет адаптации оценивается в заданном контексте. Положение в рейтинге не устанавливает
        влияние практики на рождаемость.
      </p>
      {qualified.length ? (
        <>
          <div className="workshop-rank-axis" aria-hidden="true">
            <span>−100%</span>
            <span>Баланс оценок · 0</span>
            <span>+100%</span>
          </div>
          <div className="workshop-rank-list">
            {visible.map((family) => {
              const net = family.totals!.net!;
              return (
                <article className="workshop-rank-row" key={family.id}>
                  <div className="workshop-rank-title">
                    <span
                      className="workshop-rank-position"
                      aria-label={`Место ${ranks.get(family.id)}`}
                    >
                      {ranks.get(family.id)}
                    </span>
                    <h4>{family.title}</h4>
                    <strong className="workshop-net-value" data-negative={net < 0}>
                      {percentLabel(net, true)}
                    </strong>
                  </div>
                  <div className="workshop-rank-bar" aria-hidden="true">
                    <span className="workshop-rank-zero" />
                    <span
                      data-negative={net < 0}
                      style={{
                        left: net < 0 ? `${50 + net * 50}%` : '50%',
                        width: `${Math.abs(net) * 50}%`,
                      }}
                    />
                  </div>
                  {breakdown(family)}
                  {onInspectFamily ? (
                    <button className="button button-quiet" onClick={() => onInspectFamily(family)}>
                      Разобрать региональные варианты
                    </button>
                  ) : null}
                </article>
              );
            })}
          </div>
          {pageCount > 1 ? (
            <div className="workshop-pagination">
              <button
                className="icon-button"
                aria-label="Предыдущая страница рейтинга"
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
              >
                <ChevronLeft size={19} />
              </button>
              <span>
                Страница {safePage + 1} из {pageCount}
              </span>
              <button
                className="icon-button"
                aria-label="Следующая страница рейтинга"
                disabled={safePage === pageCount - 1}
                onClick={() => setPage(safePage + 1)}
              >
                <ChevronRight size={19} />
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <div className="workshop-empty workshop-ranking-empty">
          <h4>Порог включения пока не достигнут</h4>
          <p>
            Распределения ответов приведены ниже. Место в рейтинге появится при достаточном охвате и
            числе содержательных оценок.
          </p>
        </div>
      )}
      {insufficient.length ? (
        <details className="workshop-insufficient" open={!projector || !qualified.length}>
          <summary>
            Недостаточно оценок для рейтинга <span>{insufficient.length}</span>
          </summary>
          {insufficient.map((family) => (
            <article key={family.id} className="workshop-insufficient-row">
              <h4>{family.title}</h4>
              {breakdown(family)}
              <p className="workshop-muted">
                Охват {percentLabel(family.totals?.coverage ?? null)} · содержательных оценок{' '}
                {family.totals?.substantive ?? 0}
              </p>
              {onInspectFamily ? (
                <button className="button button-quiet" onClick={() => onInspectFamily(family)}>
                  Открыть варианты и основания
                </button>
              ) : null}
            </article>
          ))}
        </details>
      ) : null}
      <details className="workshop-ranking-method">
        <summary>Как рассчитан рейтинг</summary>
        <p>
          Баланс оценок = (поддержали − не поддержали) / (поддержали + не поддержали). Ответ «Не
          могу оценить» включён в охват ответов и исключён из знаменателя баланса. Отсутствующий
          ответ учитывается отдельно.
        </p>
        <p>
          При нуле содержательных оценок баланс отсутствует. Семейства с одинаковым балансом делят
          место. Порог охвата и минимальное число содержательных оценок зафиксированы до начала
          раунда.
        </p>
        <p>
          Назначено оценивание каждого семейства: {round.eligibleCount} участникам. Состав
          участников и региональные варианты сохранены на момент открытия.
        </p>
      </details>
    </section>
  );
}

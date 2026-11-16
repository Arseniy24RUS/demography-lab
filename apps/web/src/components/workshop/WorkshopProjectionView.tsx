import { useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import type { ReactNode } from 'react';
import type { WorkshopProjection } from '../../../../../packages/workshop/types';
import { RankingResults } from './RankingResults';
import type { RegionMapRenderProps, WorkshopRegionOption } from './workshop-ui';
import '../../workshop.css';

export function WorkshopProjectionView({
  projection,
  regions,
  measureRegionIds,
  mode,
  renderMap,
  loading = false,
  error = null,
}: {
  projection: WorkshopProjection | null;
  regions: WorkshopRegionOption[];
  measureRegionIds: ReadonlySet<string>;
  mode: 'regions' | 'ranking';
  renderMap: (selection: RegionMapRenderProps) => ReactNode;
  loading?: boolean;
  error?: string | null;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  if (!projection)
    return (
      <section className="workshop-projection-body">
        <div className="workshop-empty">
          <h1>{loading ? 'Получаем результаты мастерской' : 'Мастерская пока недоступна'}</h1>
          <p>
            {error ?? 'После подключения появятся карта работы группы и результаты оценивания.'}
          </p>
        </div>
      </section>
    );
  const covered = regions.filter(region => measureRegionIds.has(region.id)).length;
  const selectedRegion = regions.find((region) => region.id === selected);
  const round = projection.round;
  return (
    <section
      className={`workshop-projection-body workshop-projection-${mode}`}
      aria-label={
        mode === 'regions'
          ? 'Карта работы группы на проекторе'
          : 'Результаты оценивания на проекторе'
      }
    >
      {error ? (
        <p className="session-message" data-tone="error" role="alert">
          {error}
        </p>
      ) : null}
      {mode === 'regions' ? (
        <>
          <div className="workshop-projection-content-heading">
            <div>
              <h2>Работа с региональными программами</h2>
              <p>Отбор практик и документальных оснований</p>
            </div>
            <div className="workshop-projection-coverage">
              <strong>
                {covered}
                <span> / {regions.length}</span>
              </strong>
              <p>регионов с отобранными мерами</p>
            </div>
          </div>
          <div className="workshop-projection-map">
            {renderMap({ selectedRegionId: selected, onSelect: setSelected })}
          </div>
          <div className="workshop-projection-map-footer">
            <p>
              {selectedRegion ? (
                <>
                  <strong>{selectedRegion.name}</strong> ·{' '}
                  {measureRegionIds.has(selectedRegion.id) ? 'Меры отобраны' : 'Меры не отобраны'}
                </>
              ) : (
                'Выберите регион для обсуждения'
              )}
            </p>
            <div>
              <span>
                Семейств <strong>{projection.familyCount}</strong>
              </span>
              <span>
                Вариантов в семействах <strong>{projection.groupedSubmissionCount}</strong>
              </span>
            </div>
          </div>
        </>
      ) : round ? (
        <>
          <div className="workshop-projection-content-heading">
            <div>
              <h2>{round.title}</h2>
              <p>{round.promptText}</p>
            </div>
          </div>
          {round.totalsVisible ? (
            <RankingResults key={round.id} round={round} projector />
          ) : (
            <div className="workshop-projection-blind">
              <LockKeyhole size={42} strokeWidth={1.6} aria-hidden="true" />
              <h2>Участники формируют свои оценки</h2>
              <p>Результаты откроются после завершения раунда.</p>
              <div className="workshop-projection-participation">
                <strong>
                  {round.participatingCount}
                  <span> / {round.eligibleCount}</span>
                </strong>
                <span>участников начали оценивание</span>
              </div>
              <progress
                max={Math.max(1, round.eligibleCount)}
                value={round.participatingCount}
                aria-label="Участники, начавшие оценивание"
              />
              <p className="workshop-muted">
                Каждому предложено {round.familyCount} семейств. Порядок индивидуален; промежуточные
                оценки скрыты.
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="workshop-empty workshop-projection-blind">
          <LockKeyhole size={40} aria-hidden="true" />
          <h1>Оценивание ещё не началось</h1>
          <p>Подготовленные семейства появятся здесь после открытия раунда.</p>
        </div>
      )}
    </section>
  );
}

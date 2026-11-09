import { useEffect, useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import type { ReactNode } from 'react';
import type { WorkshopProjection } from '../../../../../packages/workshop/types';
import { RankingResults } from './RankingResults';
import type { RegionMapRenderProps, WorkshopRegionOption } from './workshop-ui';
import { regionWorkLabels, visibleRegionStatus } from './workshop-ui';
import '../../workshop.css';

export function WorkshopProjectionView({
  projection,
  regions,
  mode,
  renderMap,
  loading = false,
  error = null,
}: {
  projection: WorkshopProjection | null;
  regions: WorkshopRegionOption[];
  mode: 'regions' | 'ranking';
  renderMap: (selection: RegionMapRenderProps) => ReactNode;
  loading?: boolean;
  error?: string | null;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, []);
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
  const counts = { available: 0, in_progress: 0, completed: 0, unavailable: 0 };
  const assignments = new Map(projection.regionWork.map((work) => [work.regionId, work]));
  for (const region of regions)
    counts[visibleRegionStatus(region.hasDocument, assignments.get(region.id), now)]++;
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
                {counts.completed}
                <span> / {regions.filter((region) => region.hasDocument).length}</span>
              </strong>
              <p>отбор завершён</p>
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
                  {
                    regionWorkLabels[
                      visibleRegionStatus(
                        selectedRegion.hasDocument,
                        assignments.get(selectedRegion.id),
                        now,
                      )
                    ]
                  }
                </>
              ) : (
                'Выберите регион для обсуждения'
              )}
            </p>
            <div>
              <span>
                В работе <strong>{counts.in_progress}</strong>
              </span>
              <span>
                Семейств <strong>{projection.familyCount}</strong>
              </span>
              <span>
                Вариантов в семействах <strong>{projection.groupedSubmissionCount}</strong>
              </span>
            </div>
          </div>
          <p className="workshop-method-note">
            Завершение отбора фиксирует вклад группы. Полнота изучения документа и качество
            источника рассматриваются отдельно.
          </p>
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

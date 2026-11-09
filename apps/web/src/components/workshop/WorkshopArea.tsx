import { useId, useRef, useState } from 'react';
import { CheckSquare, Layers3, Map, RefreshCw } from 'lucide-react';
import { RegionWorkView } from './RegionWorkView';
import { FamilyWorkbench } from './FamilyWorkbench';
import { VotingView } from './VotingView';
import type { WorkshopAreaProps, WorkshopView } from './workshop-ui';
import '../../workshop.css';

const tabs = [
  { id: 'regions', label: 'Карта программ', Icon: Map },
  { id: 'families', label: 'Семейства практик', Icon: Layers3 },
  { id: 'voting', label: 'Оценивание', Icon: CheckSquare },
] as const;

export function WorkshopArea(props: WorkshopAreaProps) {
  const id = useId();
  const [localView, setLocalView] = useState<WorkshopView>('regions');
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const nav = useRef<HTMLDivElement>(null);
  const view = props.view ?? localView;
  const setView = (next: WorkshopView) => {
    setLocalView(next);
    props.onViewChange?.(next);
  };

  async function refresh() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await props.actions.refresh();
    } catch (cause) {
      setRefreshError(cause instanceof Error ? cause.message : 'Не удалось обновить мастерскую.');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section className="workshop-area" aria-label="Исследование региональных практик">
      {!props.hideNavigation ? (
        <div
          className="workshop-tabs"
          role="tablist"
          aria-label="Этапы совместной работы"
          ref={nav}
        >
          {tabs.map(({ id: tabId, label, Icon }, index) => (
            <button
              type="button"
              role="tab"
              id={`${id}-${tabId}`}
              aria-controls={`${id}-panel`}
              aria-selected={view === tabId}
              tabIndex={view === tabId ? 0 : -1}
              key={tabId}
              onClick={() => setView(tabId)}
              onKeyDown={(event) => {
                const nextIndex =
                  event.key === 'ArrowRight'
                    ? (index + 1) % tabs.length
                    : event.key === 'ArrowLeft'
                      ? (index + tabs.length - 1) % tabs.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? tabs.length - 1
                          : null;
                if (nextIndex === null) return;
                event.preventDefault();
                setView(tabs[nextIndex]!.id);
                nav.current
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  [nextIndex]?.focus();
              }}
            >
              <Icon size={18} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {props.error || refreshError ? (
        <div className="session-message" data-tone="error" role="alert">
          <div>
            <p>{props.error || refreshError}</p>
            <button
              className="button button-secondary"
              disabled={refreshing || props.busy}
              onClick={() => void refresh()}
            >
              <RefreshCw size={15} />
              Повторить обновление
            </button>
          </div>
        </div>
      ) : null}
      <div
        id={`${id}-panel`}
        role={props.hideNavigation ? undefined : 'tabpanel'}
        aria-labelledby={props.hideNavigation ? undefined : `${id}-${view}`}
        aria-busy={props.loading && !props.snapshot}
      >
        {!props.snapshot ? (
          <div className="workshop-empty workshop-loading" role="status">
            <h2>
              {props.loading ? 'Подключаем мастерскую' : 'Материалы мастерской пока недоступны'}
            </h2>
            <p>
              {props.loading
                ? 'Получаем распределение программ, семейства и раунды оценки.'
                : 'Обновите состояние занятия после подключения серверного модуля.'}
            </p>
          </div>
        ) : view === 'regions' ? (
          <RegionWorkView {...props} snapshot={props.snapshot} />
        ) : view === 'families' ? (
          <FamilyWorkbench {...props} snapshot={props.snapshot} />
        ) : (
          <VotingView {...props} snapshot={props.snapshot} />
        )}
      </div>
    </section>
  );
}

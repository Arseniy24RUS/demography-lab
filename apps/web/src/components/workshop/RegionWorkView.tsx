import { useEffect, useId, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  Clock3,
  RotateCcw,
  Search,
  UserRound,
} from 'lucide-react';
import { Modal } from '@/components/Modal';
import type { RegionWorkInput } from '../../../../../packages/workshop/types';
import { useWorkshopTask } from './useWorkshopTask';
import { dateTimeLabel, leaseExpired, regionWorkLabels, visibleRegionStatus } from './workshop-ui';
import type { ReadyWorkshopProps } from './workshop-ui';

type WorkFilter = 'all' | 'available' | 'mine' | 'in_progress' | 'completed' | 'unavailable';

export function RegionWorkView({
  session,
  snapshot,
  currentUserId,
  regions,
  busy,
  actions,
  renderMap,
  onOpenDocument,
  onOpenSource,
}: ReadyWorkshopProps) {
  const id = useId();
  const [selectedId, setSelectedId] = useState<string | null>(
    session.session.regionId ?? regions[0]?.id ?? null,
  );
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<WorkFilter>('all');
  const [now, setNow] = useState(Date.now());
  const [completion, setCompletion] = useState<{
    regionId: string;
    name: string;
    revision: number;
    published: number;
  } | null>(null);
  const [note, setNote] = useState('');
  const task = useWorkshopTask();
  const disabled = busy || task.working;
  const host = session.session.role === 'host';
  const canWork =
    session.session.role !== 'observer' &&
    session.session.status === 'open' &&
    session.session.phase !== 'discussion';
  const allocation = useMemo(
    () => new Map(snapshot.regionWork.map((work) => [work.regionId, work])),
    [snapshot.regionWork],
  );
  const published = useMemo(
    () => session.submissions.filter((submission) => submission.status === 'shared'),
    [session.submissions],
  );
  const selectedRegion = regions.find((region) => region.id === selectedId) ?? regions[0];
  const work = selectedRegion ? allocation.get(selectedRegion.id) : undefined;
  const expired = leaseExpired(work, now);
  const status = visibleRegionStatus(selectedRegion?.hasDocument ?? false, work, now);
  const owner = work?.ownerId === currentUserId;
  const regionPractices = selectedRegion
    ? published.filter((item) => item.bundle.practice.regionId === selectedRegion.id)
    : [];
  const normalizedQuery = query.trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');
  const visibleRegions = regions
    .filter((region) => {
      const entry = allocation.get(region.id);
      const state = visibleRegionStatus(region.hasDocument, entry, now);
      return (
        (!normalizedQuery ||
          region.name.toLocaleLowerCase('ru').replaceAll('ё', 'е').includes(normalizedQuery)) &&
        (filter === 'all' ||
          (filter === 'mine'
            ? entry?.ownerId === currentUserId && state !== 'available'
            : state === filter))
      );
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const completeCount = regions.filter(
    (region) =>
      visibleRegionStatus(region.hasDocument, allocation.get(region.id), now) === 'completed',
  ).length;
  const workingCount = regions.filter(
    (region) =>
      visibleRegionStatus(region.hasDocument, allocation.get(region.id), now) === 'in_progress',
  ).length;
  const availableCount = regions.filter((region) => region.hasDocument).length;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, []);

  function select(regionId: string) {
    setSelectedId(regionId);
    task.clearError();
  }

  async function change(action: RegionWorkInput['action']) {
    if (!selectedRegion) return;
    const messages: Record<RegionWorkInput['action'], string> = {
      claim: 'Программа закреплена за вами на 30 минут. Можно открыть документ.',
      release: 'Программа освобождена. Опубликованные карточки сохранены.',
      reopen: 'Отбор по программе снова открыт.',
      renew: 'Работа продлена на 30 минут.',
      complete: 'Результат отбора сохранён.',
    };
    await task.run(
      () =>
        actions.regionWork({
          regionId: selectedRegion.id,
          action,
          expectedRevision: work?.revision ?? 0,
          note: '',
        }),
      undefined,
      messages[action],
    );
  }

  return (
    <div className="workshop-region-view">
      <div className="workshop-section-heading">
        <div>
          <h2>Распределите работу с программами</h2>
          <p>Выберите регион, найдите практики в документе и представьте их группе.</p>
        </div>
        <div className="workshop-coverage" aria-label="Охват программ">
          <span>
            <strong>{completeCount}</strong> из {availableCount} · отбор завершён
          </span>
          <span>{workingCount} в работе</span>
        </div>
      </div>
      {task.error && !completion ? (
        <p className="session-message" data-tone="error" role="alert">
          {task.error}
        </p>
      ) : null}
      {task.notice ? (
        <p className="workshop-notice" role="status">
          <Check size={16} />
          {task.notice}
        </p>
      ) : null}
      <div className="workshop-map-layout">
        <section className="workshop-map-panel" aria-label="Карта и список программ">
          <div className="workshop-search-row">
            <div className="workshop-search">
              <Search size={17} aria-hidden="true" />
              <label htmlFor={`${id}-search`} className="session-sr-only">
                Найти регион
              </label>
              <input
                id={`${id}-search`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Найти регион"
                type="search"
              />
            </div>
            <label className="workshop-filter-select">
              <span className="session-sr-only">Статус программы</span>
              <select
                value={filter}
                onChange={(event) => setFilter(event.target.value as WorkFilter)}
              >
                <option value="all">Все программы</option>
                <option value="available">Свободные</option>
                <option value="mine">Моя работа</option>
                <option value="in_progress">В работе</option>
                <option value="completed">Отбор завершён</option>
                <option value="unavailable">Нет текста</option>
              </select>
            </label>
          </div>
          <div className="workshop-map-frame">
            {renderMap({ selectedRegionId: selectedRegion?.id ?? null, onSelect: select })}
          </div>
          <div className="workshop-region-list-heading">
            <h3>Программы по названию</h3>
            <span>
              {visibleRegions.length} из {regions.length}
            </span>
          </div>
          <div
            className="workshop-region-list"
            role="group"
            aria-label="Выбрать программу по названию"
          >
            {visibleRegions.map((region) => {
              const entry = allocation.get(region.id);
              const entryStatus = visibleRegionStatus(region.hasDocument, entry, now);
              return (
                <button
                  key={region.id}
                  className="workshop-region-row"
                  aria-pressed={region.id === selectedRegion?.id}
                  onClick={() => select(region.id)}
                >
                  <BookOpen size={17} aria-hidden="true" />
                  <span className="workshop-region-row-name">{region.name}</span>
                  <span className="workshop-work-state" data-state={entryStatus}>
                    {regionWorkLabels[entryStatus]}
                  </span>
                  <ArrowUpRight size={15} aria-hidden="true" />
                </button>
              );
            })}
            {!visibleRegions.length ? (
              <p className="workshop-muted workshop-list-empty">
                По заданным условиям программ не найдено.
              </p>
            ) : null}
          </div>
        </section>
        <aside className="workshop-region-detail" aria-label="Выбранная программа">
          {selectedRegion ? (
            <>
              <h3>{selectedRegion.name}</h3>
              <div className="workshop-region-passport">
                <p className="workshop-region-document-title">
                  {selectedRegion.documentTitle ?? 'Региональная программа повышения рождаемости'}
                </p>
                <div className="workshop-region-state-line">
                  <span>Отбор практик</span>
                  <span className="workshop-work-state" data-state={status}>
                    {regionWorkLabels[status]}
                  </span>
                </div>
                {work?.ownerName && status !== 'available' && status !== 'unavailable' ? (
                  <p className="workshop-owner">
                    <UserRound size={15} aria-hidden="true" />
                    {work.ownerName}
                    {owner ? ' · вы' : ''}
                  </p>
                ) : null}
                {work?.leaseExpiresAt && status === 'in_progress' ? (
                  <p className="workshop-muted workshop-lease">
                    <Clock3 size={14} aria-hidden="true" />
                    Закреплена до{' '}
                    {new Intl.DateTimeFormat('ru-RU', {
                      hour: '2-digit',
                      minute: '2-digit',
                    }).format(new Date(work.leaseExpiresAt))}
                  </p>
                ) : null}
                {expired ? (
                  <p className="workshop-inline-warning">
                    Срок закрепления истёк. Программу можно взять снова; прежние находки сохранены.
                  </p>
                ) : null}
                {selectedRegion.documentHint ? (
                  <p className="workshop-source-hint">{selectedRegion.documentHint}</p>
                ) : null}
                <div className="workshop-region-actions">
                  {status === 'available' ? (
                    <button
                      className="button button-primary block"
                      disabled={disabled || !canWork}
                      onClick={() => void change('claim')}
                    >
                      {expired ? 'Занять освободившуюся программу' : 'Взять программу'}
                    </button>
                  ) : null}
                  <button
                    className="button button-secondary block"
                    disabled={!selectedRegion.hasDocument}
                    onClick={() => onOpenDocument(selectedRegion.id)}
                  >
                    <ArrowUpRight size={16} />
                    Открыть документ
                  </button>
                  {status === 'in_progress' && (owner || host) ? (
                    <>
                      <button
                        className="button button-primary block"
                        disabled={disabled || !canWork}
                        onClick={() => {
                          task.clearError();
                          setNote(work?.completionNote ?? '');
                          setCompletion({
                            regionId: selectedRegion.id,
                            name: selectedRegion.name,
                            revision: work?.revision ?? 0,
                            published: regionPractices.length,
                          });
                        }}
                      >
                        <CheckCircle2 size={16} />
                        Завершить отбор
                      </button>
                      <div className="workshop-region-secondary-actions">
                        <button
                          className="button button-quiet"
                          disabled={disabled || !canWork}
                          onClick={() => void change('renew')}
                        >
                          Продлить работу
                        </button>
                        <button
                          className="button button-quiet"
                          disabled={disabled || !canWork}
                          onClick={() => void change('release')}
                        >
                          Освободить программу
                        </button>
                      </div>
                    </>
                  ) : null}
                  {status === 'completed' && (owner || host) ? (
                    <button
                      className="button button-secondary block"
                      disabled={disabled || !canWork}
                      onClick={() => void change('reopen')}
                    >
                      <RotateCcw size={15} />
                      Вернуть в работу
                    </button>
                  ) : null}
                </div>
                {!canWork ? (
                  <p className="workshop-muted">
                    {session.session.role === 'observer'
                      ? 'Наблюдатель может читать документы и результаты отбора.'
                      : 'Назначения меняются при открытом занятии на этапе чтения или проверки.'}
                  </p>
                ) : status === 'in_progress' && !owner && !host ? (
                  <p className="workshop-muted">
                    Программой уже занимается другой участник. Документ доступен для чтения.
                  </p>
                ) : null}
                {status === 'unavailable' ? (
                  <p className="workshop-muted">
                    В корпусе отсутствует доступный текст. Такой регион не учитывается как
                    завершённая программа.
                  </p>
                ) : null}
                {status === 'completed' && work?.completionNote ? (
                  <div className="workshop-completion-note">
                    <strong>Результат отбора</strong>
                    <p>{work.completionNote}</p>
                    <small>{dateTimeLabel(work.updatedAt)}</small>
                  </div>
                ) : null}
              </div>
              <section className="workshop-region-practices">
                <h4>
                  Практики региона <span>{regionPractices.length}</span>
                </h4>
                {regionPractices.length ? (
                  regionPractices.map((submission) => (
                    <div key={submission.id} className="workshop-region-practice">
                      <strong>{submission.bundle.practice.title}</strong>
                      <p>{submission.authorName}</p>
                      {submission.bundle.occurrences[0] ? (
                        <button
                          className="button button-quiet"
                          onClick={() => onOpenSource(submission.bundle.occurrences[0]!.anchor)}
                        >
                          Открыть цитату
                          <ArrowUpRight size={14} />
                        </button>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <p className="workshop-muted workshop-region-practice-empty">
                    Публикаций пока нет. Найдите фрагмент в документе и отправьте связанную с ним
                    карточку в занятие.
                  </p>
                )}
              </section>
            </>
          ) : (
            <p className="workshop-muted">Выберите регион на карте или в списке.</p>
          )}
        </aside>
      </div>
      <p className="workshop-method-note">
        «Отбор завершён» фиксирует результат работы участника с программой. Полнота её изучения и
        качество исходного документа оцениваются отдельно.
      </p>
      {completion ? (
        <Modal
          title="Завершить отбор практик"
          onClose={() => {
            if (!task.working) {
              setCompletion(null);
              task.clearError();
            }
          }}
          actions={
            <>
              <button
                className="button button-secondary"
                disabled={task.working}
                onClick={() => {
                  setCompletion(null);
                  task.clearError();
                }}
              >
                Продолжить работу
              </button>
              <button
                className="button button-primary"
                disabled={
                  disabled || !canWork || (!completion.published && note.trim().length < 10)
                }
                onClick={() =>
                  void task.run(
                    () =>
                      actions.regionWork({
                        regionId: completion.regionId,
                        action: 'complete',
                        expectedRevision: completion.revision,
                        note: note.trim(),
                      }),
                    () => setCompletion(null),
                    'Результат отбора сохранён.',
                  )
                }
              >
                Подтвердить завершение
              </button>
            </>
          }
        >
          <p className="workshop-modal-lead">{completion.name}</p>
          <p>
            Опубликовано практик: <strong>{completion.published}</strong>. Укажите, какие разделы
            рассмотрены и какие вопросы требуют дальнейшей проверки.
          </p>
          {completion.published === 0 ? (
            <p className="workshop-inline-warning">
              Если практика не отобрана, требуется пояснение длиной не менее 10 символов.
            </p>
          ) : null}
          <div className="session-field workshop-modal-field">
            <label htmlFor={`${id}-completion`}>
              Результат отбора{completion.published === 0 ? ' · обязательно' : ''}
            </label>
            <textarea
              id={`${id}-completion`}
              className="session-input"
              rows={5}
              maxLength={4000}
              value={note}
              disabled={task.working}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          {snapshot.regionWork.find((entry) => entry.regionId === completion.regionId)?.revision !==
          completion.revision ? (
            <p className="workshop-inline-warning">
              Назначение изменилось после открытия формы. Ваш текст сохранён; проверьте текущее
              состояние программы.
            </p>
          ) : null}
          {task.error ? (
            <p className="session-message" data-tone="error" role="alert">
              {task.error}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}

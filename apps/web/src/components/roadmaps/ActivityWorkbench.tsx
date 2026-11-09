import { useEffect, useState } from 'react';
import { Archive, FileText, Link2, Plus } from 'lucide-react';
import type { TextAnchor } from '@domain/index';
import type { BarriersSnapshot, BarrierEvidence } from '../../../../../packages/barriers/types';
import type { RoadmapBasis } from '../../../../../packages/roadmaps/types';
import type { FrozenVariant } from '../../../../../packages/workshop/types';
import { Modal } from '../Modal';
import { PracticeDetails } from '../workshop/PracticeDetails';
import {
  activeItems,
  dateLabel,
  EditButton,
  EmptySection,
  Note,
  numeric,
  saveInput,
  SectionHeading,
  useRoadmapTask,
} from './common';
import type { RoadmapWorkspaceProps } from './common';

export function ActivityWorkbench(
  props: RoadmapWorkspaceProps & {
    barriers: BarriersSnapshot | null;
    readEvidence(id: string): Promise<BarrierEvidence>;
    onOpenSource(anchor: TextAnchor): void;
    regions: Array<{ id: string; name: string; hasDocument: boolean }>;
  },
) {
  const { snapshot, controller, editable, onEdit, barriers, readEvidence, onOpenSource, regions } =
    props;
  const [basisOpen, setBasisOpen] = useState(false),
    [sourceKey, setSourceKey] = useState(''),
    [rationale, setRationale] = useState(''),
    [evidenceId, setEvidenceId] = useState<string | null>(null),
    [archiving, setArchiving] = useState<string | null>(null);
  const task = useRoadmapTask();
  const passport = activeItems(snapshot, 'passport')[0],
    activities = activeItems(snapshot, 'activity'),
    indicators = activeItems(snapshot, 'indicator');
  const available = [
    ...(barriers?.barriers
      .filter((item) => item.status === 'active')
      .map((item) => ({
        key: `barrier:${item.id}`,
        id: item.id,
        kind: 'barrier' as const,
        title: item.title,
        description: item.description,
        revision: item.contentRevision,
        label: 'Барьер',
      })) ?? []),
    ...(barriers?.links
      .filter((item) => item.status === 'active')
      .map((item) => ({
        key: `link:${item.id}`,
        id: item.id,
        kind: 'link' as const,
        title: item.familyTitle,
        description: item.explanation,
        revision: item.revision,
        label: 'Связь с региональной практикой',
      })) ?? []),
    ...(barriers?.solutions
      .filter((item) => item.status === 'active')
      .map((item) => ({
        key: `solution:${item.id}`,
        id: item.id,
        kind: 'solution' as const,
        title: item.title,
        description: item.mechanism,
        revision: item.revision,
        label: 'Авторское решение',
      })) ?? []),
  ];
  const chosen = available.find((item) => item.key === sourceKey);
  async function capture() {
    if (!chosen) return;
    await task.run(async () => {
      await controller.actions.captureBasis({
        roadmapId: snapshot.roadmapId,
        basisId: null,
        expectedRevision: 0,
        sourceKind: chosen.kind,
        sourceId: chosen.id,
        expectedSourceRevision: chosen.revision,
        rationale,
        status: 'active',
      });
      setBasisOpen(false);
      setRationale('');
      setSourceKey('');
    }, 'Основание закреплено в дорожной карте.');
  }
  function basisTitle(basis: RoadmapBasis) {
    return basis.material.kind === 'link'
      ? basis.material.source.familyTitle
      : basis.material.source.title;
  }
  return (
    <div className="rm-activity-workbench">
      <section className="rm-section">
        <SectionHeading title="Логика проекта">
          Цель, задачи, действия и проверяемые изменения в положении семей.
        </SectionHeading>
        {passport ? (
          <article className="rm-passport">
            <div>
              <span className="rm-eyebrow">Паспорт</span>
              <h3>{passport.data.title || 'Назовите проект'}</h3>
              <p>
                {passport.data.goal ||
                  'Сформулируйте цель, которую команда сможет обосновать и проверить.'}
              </p>
            </div>
            {editable ? (
              <EditButton
                label="Заполнить паспорт"
                onClick={() => onEdit({ kind: 'passport', id: passport.id })}
              />
            ) : null}
            <dl className="rm-details">
              <div>
                <dt>Целевая группа</dt>
                <dd>{passport.data.targetGroup || 'Не определена'}</dd>
              </div>
              <div>
                <dt>Период</dt>
                <dd>
                  {dateLabel(passport.data.startDate)} — {dateLabel(passport.data.endDate)}
                </dd>
              </div>
              <div>
                <dt>Ожидаемый результат</dt>
                <dd>{passport.data.expectedResult || 'Не определён'}</dd>
              </div>
              <div>
                <dt>Партнёры</dt>
                <dd>{passport.data.partners || 'Не определены'}</dd>
              </div>
            </dl>
            {passport.data.objectives.length ? (
              <div className="rm-objectives">
                {passport.data.objectives.map((objective, index) => (
                  <div key={objective.id}>
                    <span>{index + 1}</span>
                    <p>{objective.title || 'Задача без формулировки'}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </article>
        ) : null}
      </section>
      <section className="rm-section">
        <SectionHeading
          title="Основания выбранного решения"
          onAdd={editable ? () => setBasisOpen(true) : undefined}
          addLabel="Связать с работой группы"
        >
          Сохранённые барьеры, связи с практиками и авторские решения из предыдущих этапов.
        </SectionHeading>
        <div className="rm-card-grid">
          {snapshot.basis
            .filter((item) => item.status === 'active')
            .map((basis) => (
              <article className="rm-small-card" key={basis.id}>
                <span className="rm-eyebrow">
                  {basis.sourceKind === 'barrier'
                    ? 'Барьер'
                    : basis.sourceKind === 'link'
                      ? 'Региональные практики'
                      : 'Авторское решение'}{' '}
                  · редакция {basis.sourceRevision}
                </span>
                <h4>{basisTitle(basis)}</h4>
                <p>{basis.rationale || 'Объясните связь с проектом при обсуждении команды.'}</p>
                {basis.staleReasons.length ? (
                  <Note warning>
                    Исходное основание изменилось или было снято. В карте сохранена прежняя
                    редакция. Сопоставьте её с текущей работой группы.
                  </Note>
                ) : null}
                {basis.material.kind === 'barrier' ? (
                  <p>{basis.material.source.description}</p>
                ) : basis.material.kind === 'link' ? (
                  <>
                    <p>{basis.material.source.explanation}</p>
                    <button
                      className="button button-secondary"
                      onClick={() =>
                        setEvidenceId(
                          basis.material.kind === 'link' ? basis.material.source.evidenceId : null,
                        )
                      }
                    >
                      <FileText size={15} />
                      Карточки и точные цитаты
                    </button>
                  </>
                ) : (
                  <>
                    <p>{basis.material.source.mechanism}</p>
                    {editable ? (
                      <button
                        className="button button-secondary"
                        onClick={() => {
                          if (basis.material.kind !== 'solution') return;
                          const source = basis.material.source;
                          onEdit({
                            kind: 'activity',
                            initial: {
                              title: source.title,
                              description: source.mechanism,
                              targetGroup: source.targetGroup,
                              responsible: source.responsible,
                              deliverable: source.firstStep,
                              completionCriterion: source.successIndicator,
                            },
                          });
                        }}
                      >
                        <Plus size={15} />
                        Разработать мероприятие
                      </button>
                    ) : null}
                  </>
                )}
                {editable &&
                basis.staleReasons.length &&
                available.some(
                  (item) => item.kind === basis.sourceKind && item.id === basis.sourceId,
                ) ? (
                  <button
                    className="button button-quiet"
                    disabled={task.working || controller.busy}
                    onClick={() => {
                      const source = available.find(
                        (item) => item.kind === basis.sourceKind && item.id === basis.sourceId,
                      )!;
                      void task.run(
                        () =>
                          controller.actions.captureBasis({
                            roadmapId: snapshot.roadmapId,
                            basisId: basis.id,
                            expectedRevision: basis.revision,
                            sourceKind: basis.sourceKind,
                            sourceId: basis.sourceId,
                            expectedSourceRevision: source.revision,
                            rationale: basis.rationale,
                            status: 'active',
                          }),
                        'Основание обновлено до текущей редакции.',
                      );
                    }}
                  >
                    Подтвердить текущую редакцию
                  </button>
                ) : null}
              </article>
            ))}
        </div>
        {!snapshot.basis.some((item) => item.status === 'active') ? (
          <EmptySection>
            Выберите обсуждённую проблему или решение, чтобы сохранить обоснование проекта и его
            связь с документами.
          </EmptySection>
        ) : null}
      </section>
      {task.feedback}
      <section className="rm-section">
        <SectionHeading
          title="Мероприятия"
          onAdd={editable ? () => onEdit({ kind: 'activity' }) : undefined}
          addLabel="Добавить мероприятие"
        >
          Каждое действие имеет исполнителя, срок, результат и критерий завершения.
        </SectionHeading>
        <div className="rm-activity-list">
          {activities.map((item, index) => (
            <article className="rm-activity-card" key={item.id}>
              <div className="rm-activity-number">{String(index + 1).padStart(2, '0')}</div>
              <div className="rm-activity-content">
                <div className="rm-card-title">
                  <h4>{item.data.title || 'Мероприятие без названия'}</h4>
                  <span className="rm-badge">
                    {item.data.progressStatus === 'completed'
                      ? 'Завершено'
                      : item.data.progressStatus === 'in_progress'
                        ? 'В работе'
                        : 'Запланировано'}
                  </span>
                </div>
                <p>{item.data.description || 'Опишите механизм действия.'}</p>
                <dl className="rm-activity-facts">
                  <div>
                    <dt>Для кого</dt>
                    <dd>{item.data.targetGroup || 'Не указано'}</dd>
                  </div>
                  <div>
                    <dt>Исполнитель</dt>
                    <dd>{item.data.responsible || 'Не назначен'}</dd>
                  </div>
                  <div>
                    <dt>Срок</dt>
                    <dd>
                      {dateLabel(item.data.startDate)} — {dateLabel(item.data.endDate)}
                    </dd>
                  </div>
                  <div>
                    <dt>Результат</dt>
                    <dd>{item.data.deliverable || 'Не сформулирован'}</dd>
                  </div>
                </dl>
                {item.data.completionCriterion ? (
                  <p>
                    <strong>Проверка:</strong> {item.data.completionCriterion}
                  </p>
                ) : null}
                {item.data.indicatorIds.length ? (
                  <div className="rm-linked-indicators">
                    {item.data.indicatorIds.map((id) => (
                      <span key={id}>
                        <Link2 size={13} />
                        {indicators.find((indicator) => indicator.id === id)?.data.title ??
                          'Показатель снят'}
                      </span>
                    ))}
                  </div>
                ) : null}
                <p className="rm-muted">
                  {item.data.approvalStatus === 'verified_source'
                    ? 'Команда отметила проверку полномочий'
                    : item.data.approvalStatus === 'requires_decision'
                      ? 'Необходимо решение уполномоченного органа'
                      : item.data.approvalStatus === 'contradiction'
                        ? 'Требуется устранить противоречие полномочий'
                        : 'Полномочия требуют проверки'}{' '}
                  · Редакция {item.revision}
                </p>
                <div className="rm-actions">
                  {editable ? (
                    <>
                      <EditButton onClick={() => onEdit({ kind: 'activity', id: item.id })} />
                      <button className="button button-quiet" onClick={() => setArchiving(item.id)}>
                        <Archive size={15} />
                        Убрать из проекта
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </div>
        {!activities.length ? (
          <EmptySection>
            Добавьте первое мероприятие или начните с авторского решения группы. Цель — конкретный
            проект с проверяемым механизмом.
          </EmptySection>
        ) : null}
      </section>
      <section className="rm-section">
        <SectionHeading
          title="Показатели и ориентиры"
          onAdd={editable ? () => onEdit({ kind: 'indicator' }) : undefined}
          addLabel="Добавить показатель"
        >
          Разделяйте выполненную работу, изменения для семей и демографический контекст.
        </SectionHeading>
        {indicators.length ? (
          <div className="rm-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Показатель</th>
                  <th>Базовое значение</th>
                  <th>Целевые годы</th>
                  <th>Источник</th>
                  <th>Действие</th>
                </tr>
              </thead>
              <tbody>
                {indicators.map((item) => (
                  <tr key={item.id}>
                    <th>
                      {item.data.title || 'Без названия'}
                      <small>
                        {item.data.kind === 'demographic_context'
                          ? 'Демографический контекст'
                          : item.data.kind === 'family_outcome'
                            ? 'Положение семей'
                            : item.data.kind === 'resource'
                              ? 'Ресурс'
                              : 'Непосредственный результат'}
                      </small>
                    </th>
                    <td>
                      {item.data.baselineYear ?? 'Год не задан'}: {numeric(item.data.baselineValue)}{' '}
                      {item.data.unit}
                    </td>
                    <td>
                      {item.data.annualTargets.length
                        ? item.data.annualTargets.map((target) => (
                            <div key={target.year}>
                              {target.year}: {numeric(target.value)} {item.data.unit}
                            </div>
                          ))
                        : 'Не заданы'}
                    </td>
                    <td className="rm-long-text">{item.data.sourceReference || 'Не указан'}</td>
                    <td>
                      {editable ? (
                        <EditButton onClick={() => onEdit({ kind: 'indicator', id: item.id })} />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptySection>
            Добавьте показатели непосредственного результата и положения семей. Сценарные
            демографические ориентиры можно перенести из диагностики.
          </EmptySection>
        )}
      </section>
      {basisOpen ? (
        <Modal
          title="Основание из коллективной работы"
          wide
          onClose={() => {
            if (!task.working) setBasisOpen(false);
          }}
          actions={
            <button
              className="button button-primary"
              disabled={!chosen || task.working || controller.busy}
              onClick={() => void capture()}
            >
              Закрепить основание
            </button>
          }
        >
          <Note>
            Сохраняется конкретная редакция материала. Для связи с региональной практикой
            сохраняются и исходные карточки с цитатами.
          </Note>
          <label className="rm-field">
            <span>Материал обсуждения</span>
            <select value={sourceKey} onChange={(event) => setSourceKey(event.target.value)}>
              <option value="">Выберите материал</option>
              {available.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}: {item.title}
                </option>
              ))}
            </select>
          </label>
          {!available.length ? (
            <p className="rm-empty">
              В этом занятии ещё нет активных барьеров, связей или авторских решений. Сначала
              поработайте во вкладке «Барьеры и решения».
            </p>
          ) : null}
          {chosen ? (
            <div className="rm-source-preview">
              <h3>{chosen.title}</h3>
              <p>{chosen.description}</p>
            </div>
          ) : null}
          <label className="rm-field">
            <span>Почему это основание важно для нашего проекта</span>
            <textarea
              rows={4}
              maxLength={4000}
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
            />
          </label>
          {task.feedback}
        </Modal>
      ) : null}
      {archiving ? (
        <Modal title="Убрать мероприятие из проекта?" onClose={() => setArchiving(null)}>
          <p>
            Действие будет переведено в архив. Сначала удалите или переназначьте связанные расходы и
            зависимости других мероприятий.
          </p>
          {task.feedback}
          <div className="rm-actions">
            <button
              className="button button-primary"
              disabled={task.working || controller.busy}
              onClick={() =>
                void task.run(async () => {
                  const item = activities.find((item) => item.id === archiving);
                  if (item)
                    await controller.actions.saveItem({
                      ...saveInput(snapshot.roadmapId, item),
                      status: 'archived',
                    });
                  setArchiving(null);
                }, 'Мероприятие переведено в архив.')
              }
            >
              Убрать из активного проекта
            </button>
            <button className="button button-secondary" onClick={() => setArchiving(null)}>
              Оставить
            </button>
          </div>
        </Modal>
      ) : null}
      {evidenceId ? (
        <RoadmapEvidence
          key={evidenceId}
          evidenceId={evidenceId}
          read={readEvidence}
          regions={regions}
          onOpenSource={onOpenSource}
          onClose={() => setEvidenceId(null)}
        />
      ) : null}
    </div>
  );
}
function RoadmapEvidence({
  evidenceId,
  read,
  regions,
  onOpenSource,
  onClose,
}: {
  evidenceId: string;
  read(id: string): Promise<BarrierEvidence>;
  regions: Array<{ id: string; name: string; hasDocument: boolean }>;
  onOpenSource(anchor: TextAnchor): void;
  onClose(): void;
}) {
  const [evidence, setEvidence] = useState<BarrierEvidence | null>(null),
    [error, setError] = useState<string | null>(null),
    [variant, setVariant] = useState<FrozenVariant | null>(null),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setEvidence(null);
    setError(null);
    void read(evidenceId)
      .then((value) => {
        if (active) setEvidence(value);
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : 'Не удалось открыть основания.');
      });
    return () => {
      active = false;
    };
  }, [evidenceId, read, attempt]);
  if (variant)
    return (
      <PracticeDetails
        variant={{
          id: variant.submissionId,
          revision: variant.submissionRevision,
          bundle: variant.bundle,
        }}
        regions={regions}
        onOpenSource={(anchor) => {
          onClose();
          onOpenSource(anchor);
        }}
        onClose={() => setVariant(null)}
      />
    );
  return (
    <Modal title="Документальные основания проекта" wide onClose={onClose}>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button
            className="button button-secondary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Повторить
          </button>
        </>
      ) : !evidence ? (
        <p aria-busy="true">Загружаем сохранённую редакцию…</p>
      ) : (
        <>
          <h3>{evidence.title}</h3>
          <p className="modal-intro">{evidence.mechanism}</p>
          <Note>
            Редакция семейства {evidence.familyRevision}. Карточки и цитаты закреплены на момент
            подтверждения связи.
          </Note>
          <div className="rm-card-grid">
            {evidence.variants.map((item) => (
              <button
                className="rm-evidence-card"
                key={item.submissionId}
                onClick={() => setVariant(item)}
              >
                <FileText size={22} />
                <strong>{item.bundle.practice.title}</strong>
                <span>
                  {regions.find((region) => region.id === item.bundle.practice.regionId)?.name ??
                    item.bundle.practice.regionId}{' '}
                  · {item.bundle.occurrences.length} цитат
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

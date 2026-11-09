import { useEffect, useRef, useState } from 'react';
import { Check, Download, FileCheck2, MessageSquare, Save } from 'lucide-react';
import type { RoadmapVersionSummary } from '../../../../../packages/roadmaps/types';
import { assessRoadmapReadiness } from '../../../../../packages/analytics';
import { Modal } from '../Modal';
import {
  activeItems,
  dateLabel,
  EditButton,
  EmptySection,
  Note,
  SectionHeading,
  useRoadmapTask,
} from './common';
import type { RoadmapTab, RoadmapWorkspaceProps } from './common';

export function ReviewExport({
  snapshot,
  controller,
  editable,
  onEdit,
  isHost,
  onTab,
}: RoadmapWorkspaceProps & { isHost: boolean; onTab(tab: RoadmapTab): void }) {
  const readiness = assessRoadmapReadiness(snapshot),
    monitoring = activeItems(snapshot, 'monitoring')[0],
    risks = activeItems(snapshot, 'risk');
  const [freeze, setFreeze] = useState<'draft' | 'submitted' | null>(null),
    [title, setTitle] = useState(''),
    [reviewing, setReviewing] = useState<RoadmapVersionSummary | null>(null),
    [decision, setDecision] = useState<'revise' | 'discussed'>('revise'),
    [comment, setComment] = useState('');
  const task = useRoadmapTask();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const sectionTab: Record<string, RoadmapTab> = {
    passport: 'activities',
    diagnosis: 'diagnosis',
    indicators: 'activities',
    activities: 'activities',
    calendar: 'resources',
    resources: 'resources',
    risks: 'review',
    monitoring: 'review',
  };
  async function download(versionId: string, format: 'docx' | 'pdf') {
    await task.run(async () => {
      const version = await controller.actions.readVersion(snapshot.roadmapId, versionId);
      if (!mounted.current) return;
      const { downloadRoadmapVersion } = await import('../../lib/roadmap-export');
      await downloadRoadmapVersion(version, format, () => mounted.current);
    }, 'Файл подготовлен из выбранной зафиксированной версии.');
  }
  return (
    <div className="rm-review">
      <section className="rm-section">
        <SectionHeading title="Проверка дорожной карты">
          Восемь разделов шаблона организаторов. Заполненность помогает найти пробелы, но не
          оценивает научную обоснованность проекта.
        </SectionHeading>
        <div className="rm-readiness-overview">
          <div>
            <strong>{readiness.completedSections} / 8</strong>
            <span>разделов заполнено</span>
          </div>
          <div
            className="rm-progress-track"
            role="progressbar"
            aria-label="Полнота заполнения документа"
            aria-valuenow={readiness.percentComplete}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${readiness.percentComplete}%` }} />
          </div>
          <span>
            {readiness.completedChecks} из {readiness.totalChecks} условий
          </span>
        </div>
        <div className="rm-readiness-grid">
          {readiness.sections.map((section, index) => (
            <article
              key={section.id}
              className="rm-readiness-card"
              data-complete={section.complete}
            >
              <div>
                <span className="rm-step-number">
                  {section.complete ? <Check size={17} /> : index + 1}
                </span>
                <h3>{section.title}</h3>
              </div>
              <details>
                <summary>
                  {section.checks.filter((check) => check.complete).length} из{' '}
                  {section.checks.length} условий
                </summary>
                {section.checks.map((check) => (
                  <p className="rm-readiness-check" key={check.id}>
                    <span aria-label={check.complete ? 'Выполнено' : 'Не выполнено'}>
                      {check.complete ? '✓' : '○'}
                    </span>
                    {check.label}
                  </p>
                ))}
              </details>
              <button
                className="button button-quiet"
                onClick={() => onTab(sectionTab[section.id]!)}
              >
                Открыть раздел
              </button>
            </article>
          ))}
        </div>
        {readiness.issues.length ? (
          <details className="rm-review-issues" open>
            <summary>Требуют внимания: {readiness.issues.length}</summary>
            {readiness.issues.map((issue, index) => (
              <p key={`${issue.code}-${index}`} data-severity={issue.severity}>
                {issue.message}
              </p>
            ))}
          </details>
        ) : null}
      </section>
      <section className="rm-section">
        <SectionHeading
          title="Риски и резервные действия"
          onAdd={editable ? () => onEdit({ kind: 'risk' }) : undefined}
          addLabel="Добавить риск"
        />
        {risks.length ? (
          <div className="rm-card-grid">
            {risks.map((item) => (
              <article className="rm-small-card" key={item.id}>
                <h4>{item.data.title || 'Риск без названия'}</h4>
                <p>
                  <strong>Профилактика:</strong> {item.data.mitigation || 'Не указана'}
                </p>
                <p>
                  <strong>Сигнал:</strong> {item.data.trigger || 'Не указан'}
                </p>
                <p>
                  <strong>Резерв:</strong> {item.data.contingency || 'Не определён'}
                </p>
                <p className="rm-muted">Ответственный: {item.data.owner || 'не назначен'}</p>
                {editable ? (
                  <EditButton onClick={() => onEdit({ kind: 'risk', id: item.id })} />
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <EmptySection>
            Обсудите, что может сорвать реализацию, как заметить это заранее и какое действие станет
            резервным.
          </EmptySection>
        )}
      </section>
      <section className="rm-section">
        <SectionHeading title="Мониторинг и устойчивость" />
        {monitoring ? (
          <article className="rm-monitoring-summary">
            <dl className="rm-resource-description">
              <div>
                <dt>Периодичность</dt>
                <dd>{monitoring.data.frequency || 'Не определена'}</dd>
              </div>
              <div>
                <dt>Метод проверки</dt>
                <dd>{monitoring.data.method || 'Не определён'}</dd>
              </div>
              <div>
                <dt>Ответственный</dt>
                <dd>{monitoring.data.responsible || 'Не назначен'}</dd>
              </div>
              <div>
                <dt>Промежуточный отчёт</dt>
                <dd>{dateLabel(monitoring.data.interimReportDate)}</dd>
              </div>
              <div>
                <dt>Итоговый отчёт</dt>
                <dd>{dateLabel(monitoring.data.finalReportDate)}</dd>
              </div>
              <div>
                <dt>Качественные результаты</dt>
                <dd>{monitoring.data.qualitativeResults || 'Не описаны'}</dd>
              </div>
              <div>
                <dt>Устойчивость</dt>
                <dd>{monitoring.data.sustainability || 'Не описана'}</dd>
              </div>
            </dl>
            {editable ? (
              <EditButton
                label="Настроить мониторинг"
                onClick={() => onEdit({ kind: 'monitoring', id: monitoring.id })}
              />
            ) : null}
          </article>
        ) : null}
      </section>
      <section className="rm-section">
        <SectionHeading title="Версии и экспорт">
          Каждый документ строится из неизменяемой версии: текст, расчёты, источники и
          предупреждения сохраняются вместе.
        </SectionHeading>
        <div className="rm-export-toolbar">
          {editable ? (
            <>
              <button
                className="button button-secondary"
                disabled={controller.busy || task.working}
                onClick={() => {
                  setFreeze('draft');
                  setTitle(`Рабочая версия ${snapshot.versions.length + 1}`);
                }}
              >
                <Save size={17} />
                Зафиксировать черновик
              </button>
              <button
                className="button button-primary"
                disabled={controller.busy || task.working}
                onClick={() => {
                  setFreeze('submitted');
                  setTitle(`К обсуждению: ${snapshot.territory.name}`.slice(0, 240));
                }}
              >
                <FileCheck2 size={17} />
                Подготовить к обсуждению
              </button>
            </>
          ) : null}
        </div>
        {task.feedback}
        {snapshot.versions.length ? (
          <div className="rm-version-list">
            {[...snapshot.versions]
              .sort((a, b) => b.number - a.number)
              .map((version) => (
                <article className="rm-version" key={version.id}>
                  <div className="rm-version-heading">
                    <div>
                      <span className="rm-eyebrow">
                        Версия {version.number} ·{' '}
                        {version.kind === 'draft' ? 'Черновик' : 'К обсуждению'}
                      </span>
                      <h3>{version.title}</h3>
                      <p>
                        {new Date(version.createdAt).toLocaleString('ru-RU')} · редакция карты{' '}
                        {version.roadmapRevision}
                      </p>
                    </div>
                    <Download size={22} />
                  </div>
                  <div className="rm-export-buttons">
                    {(['docx', 'pdf'] as const).map((format) => (
                      <button
                        key={format}
                        className="button button-secondary"
                        disabled={task.working}
                        onClick={() => void download(version.id, format)}
                      >
                        <Download size={15} />
                        {format.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  <details className="rm-source-details">
                    <summary>Контрольная сумма и воспроизводимость</summary>
                    <p>
                      SHA-256 канонического снимка: <code>{version.sha256}</code>
                    </p>
                    <p>
                      Экспорт проверяет соответствие снимка контрольной сумме до формирования
                      файлов. Более поздние правки команды не изменяют эту версию.
                    </p>
                  </details>
                  {version.review ? (
                    <div className="rm-version-review">
                      <strong>
                        {version.review.decision === 'revise' ? 'Требуется доработка' : 'Обсуждено'}{' '}
                        · {version.review.reviewerName}
                      </strong>
                      <p>{version.review.comment}</p>
                    </div>
                  ) : null}
                  {isHost ? (
                    <button
                      className="button button-quiet"
                      disabled={controller.busy || task.working}
                      onClick={() => {
                        setReviewing(version);
                        setDecision(version.review?.decision ?? 'revise');
                        setComment(version.review?.comment ?? '');
                      }}
                    >
                      <MessageSquare size={16} />
                      {version.review ? 'Изменить обратную связь' : 'Обратная связь преподавателя'}
                    </button>
                  ) : null}
                </article>
              ))}
          </div>
        ) : (
          <EmptySection>
            Зафиксируйте первую версию, чтобы скачать дорожную карту в DOCX или PDF. После
            этого команда сможет продолжить редактирование.
          </EmptySection>
        )}
      </section>
      {freeze ? (
        <Modal
          title={
            freeze === 'draft' ? 'Зафиксировать рабочую версию' : 'Подготовить версию к обсуждению'
          }
          onClose={() => {
            if (!task.working) setFreeze(null);
          }}
        >
          <label className="rm-field">
            <span>Название версии</span>
            <input
              maxLength={240}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <Note>
            Сохранится текущее состояние карты вместе с источниками. {readiness.completedSections}{' '}
            из 8 разделов заполнено. Метка «к обсуждению» обозначает этап учебной работы.
          </Note>
          {task.feedback}
          <div className="rm-actions">
            <button
              className="button button-primary"
              disabled={!title.trim() || task.working || controller.busy}
              onClick={() =>
                void task.run(async () => {
                  await controller.actions.freeze({
                    roadmapId: snapshot.roadmapId,
                    expectedRevision: snapshot.revision,
                    title: title.trim(),
                    kind: freeze,
                  });
                  setFreeze(null);
                }, 'Неизменяемая версия сохранена. Выберите формат выгрузки.')
              }
            >
              Зафиксировать версию
            </button>
            <button
              className="button button-secondary"
              disabled={task.working}
              onClick={() => setFreeze(null)}
            >
              Вернуться к работе
            </button>
          </div>
        </Modal>
      ) : null}
      {reviewing ? (
        <Modal
          title="Обратная связь по версии"
          onClose={() => {
            if (!task.working) setReviewing(null);
          }}
        >
          <p className="modal-intro">
            Версия {reviewing.number}: {reviewing.title}
          </p>
          <label className="rm-field">
            <span>Итог обсуждения</span>
            <select
              value={decision}
              onChange={(event) => setDecision(event.target.value as 'revise' | 'discussed')}
            >
              <option value="revise">Нужна доработка</option>
              <option value="discussed">Обсуждено</option>
            </select>
          </label>
          <label className="rm-field">
            <span>Комментарий преподавателя</span>
            <textarea
              rows={5}
              maxLength={4000}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
          </label>
          {task.feedback}
          <button
            className="button button-primary"
            disabled={!comment.trim() || task.working || controller.busy}
            onClick={() =>
              void task.run(async () => {
                await controller.actions.review({
                  roadmapId: snapshot.roadmapId,
                  versionId: reviewing.id,
                  expectedRevision: reviewing.review?.revision ?? 0,
                  decision,
                  comment: comment.trim(),
                });
                setReviewing(null);
              }, 'Обратная связь сохранена.')
            }
          >
            Сохранить обратную связь
          </button>
        </Modal>
      ) : null}
    </div>
  );
}

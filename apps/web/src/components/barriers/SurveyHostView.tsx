import { useEffect, useId, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  Clipboard,
  Download,
  ExternalLink,
  Eye,
  FileText,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  UnlockKeyhole,
} from 'lucide-react';
import { Modal } from '@/components/Modal';
import type {
  SurveyActionInput,
  SurveyConfigInput,
  SurveyHostState,
  SurveySummary,
} from '../../../../../packages/barriers/types';
import type { BarrierBoardContext } from './barriers-ui';
import { BarrierEditor } from './BarrierEditor';
import { Empty, RevisionNotice, TaskMessage, useBarrierTask } from './common';

import { perspectiveLabels } from './survey-labels';
const statuses = { draft: 'Черновик', open: 'Открыт', closed: 'Закрыт', purged: 'Ответы удалены' };
export function SurveyHostView({ context }: { context: BarrierBoardContext }) {
  const survey = context.snapshot.survey;
  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState(false);
  const [privateState, setPrivateState] = useState<SurveyHostState | null>(null);
  const [privateVisible, setPrivateVisible] = useState(false);
  const [confirm, setConfirm] = useState<SurveyActionInput['action'] | null>(null);
  const task = useBarrierTask();
  const currentSurvey = useRef(survey);
  currentSurvey.current = survey;
  const privateRequest = useRef(0);
  function hidePrivate() {
    privateRequest.current += 1;
    setPrivateState(null);
    setPrivateVisible(false);
  }
  useEffect(() => {
    // Reset on a new survey even if purge and creation happened between two polls.
    hidePrivate();
    return () => {
      privateRequest.current += 1;
    };
  }, [survey?.id, survey?.status, survey?.expired]);
  function loadPrivate() {
    if (!survey || survey.status === 'purged' || survey.expired) return;
    const capturedId = survey.id;
    const requestId = ++privateRequest.current;
    void task.run(
      () => context.actions.readSurvey(capturedId),
      (value) => {
        const current = currentSurvey.current;
        if (
          requestId !== privateRequest.current ||
          current?.id !== capturedId ||
          current.status === 'purged' ||
          current.expired ||
          value.survey.id !== capturedId
        )
          return;
        setPrivateState(value);
        setPrivateVisible(true);
      },
    );
  }
  function manage() {
    if (!survey || !confirm) return;
    const action = confirm;
    void task.run(
      () =>
        context.actions.manageSurvey({
          surveyId: survey.id,
          expectedRevision: survey.revision,
          action,
        }),
      () => {
        setConfirm(null);
        hidePrivate();
      },
    );
  }
  return (
    <section className="barrier-survey-host">
      <header className="barrier-section-heading">
        <div>
          <h2>Опрос перед обсуждением</h2>
          <p>Отдельная форма без связи ответов с учебными профилями.</p>
        </div>
        {(!survey || survey.status === 'purged') && context.editable ? (
          <button className="button button-primary" onClick={() => setEditing(true)}>
            <Plus size={18} />
            Создать опрос
          </button>
        ) : null}
      </header>
      {!survey || survey.status === 'purged' ? (
        <Empty title={survey ? 'Предыдущие ответы удалены' : 'Подготовьте форму и объясните цель'}>
          Два открытых вопроса, различение личной и профессиональной перспективы, необязательные
          исследовательские вопросы. Приглашение появится после сохранения.
        </Empty>
      ) : (
        <>
          <div className="barrier-survey-overview">
            <div>
              <span className="barrier-chip">
                {statuses[survey.status]}
                {survey.expired ? ' · срок хранения истёк' : ''}
              </span>
              <h3>{survey.title}</h3>
              <p>{survey.purpose}</p>
              <p className="barrier-muted">Контакт организатора: {survey.organizerContact}</p>
              <p className="barrier-muted">
                Хранение до{' '}
                {new Date(survey.retentionUntil).toLocaleDateString('ru-RU', { timeZone: 'UTC' })}.
                После открытия формулировки и срок не редактируются.
              </p>
              <div className="barrier-survey-controls">
                {survey.status === 'draft' ? (
                  <>
                    <button
                      className="button button-secondary"
                      disabled={!context.editable}
                      onClick={() => setEditing(true)}
                    >
                      <Pencil size={16} />
                      Настроить опрос
                    </button>
                    <button
                      className="button button-primary"
                      disabled={!context.editable || survey.expired}
                      onClick={() => setConfirm('open')}
                    >
                      <UnlockKeyhole size={16} />
                      Открыть опрос
                    </button>
                  </>
                ) : null}
                {survey.status === 'open' ? (
                  <button
                    className="button button-primary"
                    disabled={task.working}
                    onClick={() => setConfirm('close')}
                  >
                    <LockKeyhole size={16} />
                    Закрыть опрос
                  </button>
                ) : null}
                <button
                  className="button button-quiet"
                  disabled={task.working}
                  onClick={() => setConfirm('purge')}
                >
                  <Trash2 size={16} />
                  Удалить ответы опроса
                </button>
              </div>
            </div>
            <aside className="barrier-survey-invite">
              <h4>Ссылка для участников</h4>
              {context.surveyInvitationUrl ? (
                <>
                  <div className="barrier-survey-qr">
                    <QRCodeSVG
                      value={context.surveyInvitationUrl}
                      size={160}
                      marginSize={2}
                      title="QR-код отдельной формы опроса"
                    />
                  </div>
                  <a
                    href={context.surveyInvitationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="button button-secondary"
                  >
                    <ExternalLink size={16} />
                    Открыть отдельную форму
                  </a>
                  <button
                    className="button button-quiet"
                    onClick={() =>
                      void task.run(
                        () => navigator.clipboard.writeText(context.surveyInvitationUrl!),
                        undefined,
                        'Ссылка скопирована.',
                      )
                    }
                  >
                    <Clipboard size={16} />
                    Копировать ссылку
                  </button>
                </>
              ) : (
                <p className="barrier-muted">
                  Секрет приглашения отсутствует в этом браузере. Создайте новую ссылку; прежняя
                  перестанет принимать новые ответы.
                </p>
              )}
              {context.surveyInvitationError ? (
                <p className="barrier-feedback error">{context.surveyInvitationError}</p>
              ) : null}
              <button
                className="button button-quiet"
                disabled={!context.editable || survey.status === 'closed' || survey.expired}
                onClick={() => setConfirm('rotate')}
              >
                <RefreshCw size={15} />
                Заменить приглашение
              </button>
            </aside>
          </div>
          <div className="barrier-survey-questions">
            <div>
              <span>Вопрос о барьерах</span>
              <p>{survey.questions.q01}</p>
            </div>
            <div>
              <span>Вопрос об условиях</span>
              <p>{survey.questions.q02}</p>
            </div>
          </div>
          <section className="barrier-survey-privacy">
            <div>
              <h3>
                <Eye size={19} />
                Только для преподавателя
              </h3>
              <p>
                Открытые ответы не попадают на общую доску или экран проектора. На общих экранах
                число ответов показывается только от пяти анкет. Текст может содержать узнаваемые
                сведения; перед обсуждением сформулируйте собственное обобщение.
              </p>
            </div>
            <div className="barrier-survey-controls">
              <button
                className="button button-secondary"
                disabled={task.working || survey.expired}
                onClick={loadPrivate}
              >
                <Eye size={16} />
                {privateVisible ? 'Обновить ответы' : 'Просмотреть ответы'}
              </button>
              <button
                className="button button-secondary"
                disabled={task.working || survey.expired}
                onClick={() =>
                  void task.run(
                    () => context.actions.exportResearch(survey.id),
                    undefined,
                    'Исследовательская выгрузка подготовлена.',
                  )
                }
              >
                <Download size={16} />
                Выгрузить для исследования
              </button>
              <button
                className="button button-primary"
                disabled={!context.editable}
                onClick={() => setSummary(true)}
              >
                <FileText size={16} />
                Сформулировать обобщение
              </button>
            </div>
            <p className="barrier-muted">
              В исследовательскую выгрузку входят только актуальные ответы с отдельным согласием.
              Разрешение на цитирование учитывается отдельно. Опрос аудитории не является
              репрезентативной выборкой населения.
            </p>
          </section>
          {privateVisible &&
          privateState &&
          privateState.survey.id === survey.id &&
          !survey.expired ? (
            <section
              className="barrier-private-responses"
              aria-label="Ответы, доступные только преподавателю"
            >
              <header>
                <h3>Ответы для анализа преподавателем</h3>
                <button className="button button-secondary" onClick={hidePrivate}>
                  Скрыть ответы
                </button>
              </header>
              <p className="barrier-muted">
                Анкет: {privateState.responseCount} · согласие на исследование:{' '}
                {privateState.researchCount} · согласие на цитирование: {privateState.quoteCount}.
                Для актуальности перед анализом обновите ответы.
              </p>
              {privateState.responses.length ? (
                privateState.responses.map((response, index) => (
                  <article key={response.rowKey} className="barrier-private-response">
                    <div className="barrier-card-overline">
                      <span>Ответ {index + 1}</span>
                      <span>{perspectiveLabels[response.perspective]}</span>
                      <span>{response.responseDate}</span>
                    </div>
                    <dl>
                      <dt>Барьеры</dt>
                      <dd>{response.answerBarrier ?? 'Вопрос пропущен'}</dd>
                      <dt>Условия</dt>
                      <dd>{response.answerSupport ?? 'Вопрос пропущен'}</dd>
                      {response.priorityChange ? (
                        <>
                          <dt>Приоритетное изменение</dt>
                          <dd>{response.priorityChange}</dd>
                        </>
                      ) : null}
                      {response.additionalConditions ? (
                        <>
                          <dt>Дополнительные условия</dt>
                          <dd>{response.additionalConditions}</dd>
                        </>
                      ) : null}
                    </dl>
                    <p className="barrier-muted">
                      Исследование: {response.consentResearch ? 'согласие дано' : 'согласия нет'}.
                      Цитирование: {response.consentQuote ? 'согласие дано' : 'согласия нет'}.
                    </p>
                  </article>
                ))
              ) : (
                <Empty title="Сохранённых ответов пока нет" />
              )}
            </section>
          ) : null}
        </>
      )}
      <TaskMessage error={task.error} notice={task.notice} />
      {editing ? (
        <SurveyEditor
          context={context}
          survey={survey?.status === 'draft' ? survey : undefined}
          onClose={() => setEditing(false)}
        />
      ) : null}
      {summary ? (
        <BarrierEditor context={context} surveySummary onClose={() => setSummary(false)} />
      ) : null}
      {confirm && survey ? (
        <Modal
          title={
            confirm === 'open'
              ? 'Открыть опрос?'
              : confirm === 'close'
                ? 'Завершить приём ответов?'
                : confirm === 'rotate'
                  ? 'Заменить ссылку приглашения?'
                  : 'Удалить все ответы этого опроса?'
          }
          onClose={() => setConfirm(null)}
          actions={
            <>
              <button className="button button-secondary" onClick={() => setConfirm(null)}>
                Отмена
              </button>
              <button className="button button-primary" disabled={task.working} onClick={manage}>
                {task.working
                  ? 'Выполняем…'
                  : confirm === 'open'
                    ? 'Открыть опрос'
                    : confirm === 'close'
                      ? 'Закрыть опрос'
                      : confirm === 'rotate'
                        ? 'Создать новую ссылку'
                        : 'Удалить все ответы'}
              </button>
            </>
          }
        >
          <p>
            {confirm === 'open'
              ? 'Формулировки, цель и срок хранения будут зафиксированы. Участники смогут отвечать через отдельную ссылку.'
              : confirm === 'close'
                ? 'Приём новых и изменённых ответов завершится окончательно. Участники сохранят возможность удалить собственный ответ по личному ключу.'
                : confirm === 'rotate'
                  ? 'Прежняя ссылка перестанет принимать новые ответы. Личные ключи ранее ответивших сохранят возможность просмотра и удаления.'
                  : 'Открытые тексты и ответы будут удалены из рабочей базы. Резервные копии обслуживаются вне приложения. Ранее выгруженные файлы автоматически не удаляются; обобщённые именные барьеры сохраняются отдельно.'}
          </p>
          <TaskMessage error={task.error} />
        </Modal>
      ) : null}
    </section>
  );
}
function SurveyEditor({
  context,
  survey,
  onClose,
}: {
  context: BarrierBoardContext;
  survey?: SurveySummary;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<SurveyConfigInput>(() => ({
    surveyId: survey?.id ?? null,
    expectedRevision: survey?.revision ?? 0,
    title: survey?.title ?? 'Барьеры и условия родительства',
    purpose:
      survey?.purpose ??
      'Выявить обсуждаемые участниками препятствия к родительству и условия, которые могли бы изменить ситуацию, для учебной проектной работы.',
    organizerContact: survey?.organizerContact ?? '',
    retentionUntil:
      survey?.retentionUntil ?? new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
    questionBarrier:
      survey?.questions.q01 ??
      'Какие обстоятельства сейчас затрудняют решение о рождении первого или следующего ребёнка? Опишите наиболее важные для выбранной вами перспективы.',
    questionSupport:
      survey?.questions.q02 ??
      'Какие изменения или формы поддержки могли бы существенно изменить эту ситуацию? Укажите условия, при которых они могли бы помочь.',
  }));
  const id = useId();
  const task = useBarrierTask();
  const latest = context.snapshot.survey;
  const changed =
    !!survey && !!latest && latest.id === survey.id && latest.revision !== draft.expectedRevision;
  const frozen = !!survey && latest?.id === survey.id && latest.status !== 'draft';
  function update<K extends keyof SurveyConfigInput>(field: K, value: SurveyConfigInput[K]) {
    setDraft((old) => ({ ...old, [field]: value }));
  }
  return (
    <Modal
      title={survey ? 'Настройка опроса' : 'Новый опрос'}
      onClose={onClose}
      wide
      actions={
        <>
          <button className="button button-secondary" onClick={onClose}>
            Отмена
          </button>
          <button
            className="button button-primary"
            type="submit"
            form={id}
            disabled={task.working || changed || frozen}
          >
            {task.working ? 'Сохраняем…' : 'Сохранить настройки'}
          </button>
        </>
      }
    >
      <form
        id={id}
        className="barrier-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (frozen || changed) return;
          void task.run(() => context.actions.saveSurvey(draft), onClose);
        }}
      >
        <label>
          Название опроса
          <input
            required
            minLength={5}
            maxLength={240}
            value={draft.title}
            onChange={(event) => update('title', event.target.value)}
          />
        </label>
        <label>
          Цель и использование ответов
          <textarea
            required
            minLength={20}
            maxLength={4000}
            rows={3}
            value={draft.purpose}
            onChange={(event) => update('purpose', event.target.value)}
          />
        </label>
        <div className="barrier-form-columns">
          <label>
            Контакт организатора
            <input
              required
              minLength={5}
              maxLength={1000}
              value={draft.organizerContact}
              onChange={(event) => update('organizerContact', event.target.value)}
              placeholder="Имя организатора и адрес для связи"
            />
          </label>
          <label>
            Хранить ответы до
            <input
              required
              type="date"
              min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
              value={draft.retentionUntil.slice(0, 10)}
              onChange={(event) => {
                if (event.target.value) update('retentionUntil', event.target.value);
              }}
            />
          </label>
        </div>
        <label>
          Вопрос о барьерах
          <textarea
            required
            minLength={10}
            maxLength={1000}
            rows={3}
            value={draft.questionBarrier}
            onChange={(event) => update('questionBarrier', event.target.value)}
          />
        </label>
        <label>
          Вопрос об условиях
          <textarea
            required
            minLength={10}
            maxLength={1000}
            rows={3}
            value={draft.questionSupport}
            onChange={(event) => update('questionSupport', event.target.value)}
          />
        </label>
        <p className="barrier-note">
          Остальные вопросы сохраняют единую версию анкеты: перспектива ответа, необязательные
          намерения и условия изменения, отдельные согласия. Организатор отвечает за фактический
          срок хранения и процедуру удаления.
        </p>
        <RevisionNotice
          changed={changed}
          onAccept={() =>
            latest && setDraft((old) => ({ ...old, expectedRevision: latest.revision }))
          }
        >
          <p>
            Актуальный опрос: {latest?.title}. Статус: {latest ? statuses[latest.status] : ''}.
          </p>
        </RevisionNotice>
        {frozen ? (
          <p className="barrier-feedback error">
            Опрос уже открыт или завершён. Настройки зафиксированы.
          </p>
        ) : null}
        <TaskMessage error={task.error} />
      </form>
    </Modal>
  );
}

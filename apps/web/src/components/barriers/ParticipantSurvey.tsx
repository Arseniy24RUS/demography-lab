import { randomUuid } from '../../../../../packages/security/crypto.mjs';
import { useEffect, useId, useState } from 'react';
import {
  Check,
  ChevronDown,
  Download,
  Eye,
  KeyRound,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react';
import { Modal } from '@/components/Modal';
import type {
  SurveyAnswerFields,
  SurveyConditional,
  SurveyHorizon,
  SurveyIntention,
  SurveyOwnResponse,
  SurveyPerspective,
} from '../../../../../packages/barriers/types';
import type { ParticipantSurveyProps } from './barriers-ui';
import { Busy, TaskMessage, useBarrierTask } from './common';
import {
  conditionalLabels,
  horizonLabels,
  intentionLabels,
  perspectiveLabels,
} from './survey-labels';

function blankAnswer(): SurveyAnswerFields {
  return {
    perspective: 'self',
    intention12m: null,
    intention36m: null,
    answerBarrier: null,
    answerSupport: null,
    priorityChange: null,
    priorityConditionId: null,
    horizon: null,
    conditionalChange: null,
    additionalConditions: null,
    consentEducational: false,
    consentResearch: false,
    consentQuote: false,
    adultConfirmed: false,
  };
}
function fieldsFrom(response: SurveyOwnResponse): SurveyAnswerFields {
  const {
    status: _status,
    revision: _revision,
    questionVersion: _questionVersion,
    availability: _availability,
    ...fields
  } = response;
  return fields;
}
function clearSubstantive(fields: SurveyAnswerFields): SurveyAnswerFields {
  return {
    ...fields,
    intention12m: null,
    intention36m: null,
    answerBarrier: null,
    answerSupport: null,
    priorityChange: null,
    priorityConditionId: null,
    horizon: null,
    conditionalChange: null,
    additionalConditions: null,
  };
}
export function ParticipantSurvey(props: ParticipantSurveyProps) {
  const { manifest, response } = props;
  const [draft, setDraft] = useState<SurveyAnswerFields>(() =>
    response?.status === 'submitted' ? fieldsFrom(response) : blankAnswer(),
  );
  const [perspective, setPerspective] = useState<SurveyPerspective | ''>(() =>
    response?.status === 'submitted' ? response.perspective : '',
  );
  const [dirty, setDirty] = useState(false);
  const [revision, setRevision] = useState(response?.revision ?? 0);
  const [showOptional, setShowOptional] = useState(false);
  const [showSecret, setShowSecret] = useState<string | null>(null);
  const [restoreSecret, setRestoreSecret] = useState('');
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [withdrawConfirm, setWithdrawConfirm] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const task = useBarrierTask();
  const formId = useId();
  const withdrawn = response?.status === 'withdrawn';
  const submitted = response?.status === 'submitted';
  const canEdit =
    !!manifest?.canRespond &&
    !manifest.expired &&
    manifest.status === 'open' &&
    !withdrawn &&
    response?.availability !== 'expired' &&
    response?.availability !== 'purged';
  const changed = !!response && response.revision !== revision && dirty;
  const working = !!props.busy || task.working;
  useEffect(() => {
    if (response?.status === 'withdrawn') {
      setDraft(blankAnswer());
      setPerspective('');
      setDirty(false);
      setRevision(response.revision);
      setSaved(false);
      return;
    }
    if (response && !dirty) {
      setDraft(response.status === 'submitted' ? fieldsFrom(response) : blankAnswer());
      setPerspective(response.status === 'submitted' ? response.perspective : '');
      setRevision(response.revision);
    }
  }, [response, dirty]);
  function update<K extends keyof SurveyAnswerFields>(field: K, value: SurveyAnswerFields[K]) {
    setDraft((old) => ({ ...old, [field]: value }));
    setDirty(true);
    setSaved(false);
    setValidation(null);
  }
  function choosePerspective(value: SurveyPerspective | '') {
    setPerspective(value);
    setDraft((old) => {
      let next = { ...old, perspective: value || 'self' };
      if (value === 'decline') next = clearSubstantive(next);
      else if (value !== 'self')
        next = { ...next, intention12m: null, intention36m: null, conditionalChange: null };
      return next;
    });
    setDirty(true);
    setSaved(false);
    setValidation(null);
  }
  function accept(response: SurveyOwnResponse) {
    setDraft(response.status === 'submitted' ? fieldsFrom(response) : blankAnswer());
    setPerspective(response.status === 'submitted' ? response.perspective : '');
    setRevision(response.revision);
    setDirty(false);
    setValidation(null);
    setSaved(response.status === 'submitted');
  }
  async function submit() {
    if (!canEdit || working || changed) return;
    if (!perspective) {
      setValidation('Выберите, с какой позиции отвечаете.');
      return;
    }
    if (perspective !== 'decline' && !draft.answerBarrier?.trim() && !draft.answerSupport?.trim()) {
      setValidation(
        'Ответьте хотя бы на один открытый вопрос. Второй можно пропустить; также можно выбрать «Предпочитаю не отвечать».',
      );
      return;
    }
    if (!draft.adultConfirmed || !draft.consentEducational) {
      setValidation(
        'Для отправки подтвердите совершеннолетие и согласие на учебное использование. Участие добровольное.',
      );
      return;
    }
    const raw = perspective === 'decline' ? clearSubstantive(draft) : draft;
    const fields = {
      ...raw,
      answerBarrier: raw.answerBarrier?.trim() ? raw.answerBarrier : null,
      answerSupport: raw.answerSupport?.trim() ? raw.answerSupport : null,
      priorityChange: raw.priorityChange?.trim() ? raw.priorityChange : null,
      priorityConditionId: raw.priorityChange?.trim() ? raw.priorityConditionId : null,
      conditionalChange: raw.priorityChange?.trim() ? raw.conditionalChange : null,
      additionalConditions: raw.additionalConditions?.trim() ? raw.additionalConditions : null,
    };
    await task.run(
      () =>
        props.onSave({
          ...fields,
          perspective,
          expectedRevision: revision,
          questionVersion: manifest!.questionVersion,
        }),
      accept,
    );
  }
  const readOnlyReason = withdrawn
    ? 'Ваш ответ удалён. Личный ключ подтверждает отзыв; повторное сохранение по нему невозможно.'
    : manifest?.expired || response?.availability === 'expired'
      ? 'Срок хранения истёк. Просмотр и изменение текстов недоступны; удалить свой ответ по личному ключу по-прежнему можно.'
      : manifest?.status === 'purged' || response?.availability === 'purged'
        ? 'Организатор удалил ответы. Новые ответы по этому приглашению не принимаются.'
        : manifest?.status === 'closed' || response?.availability === 'closed'
          ? 'Приём ответов завершён. Сохранённый ответ можно просмотреть и удалить по личному ключу.'
          : manifest?.status === 'draft'
            ? 'Опрос ещё не открыт. Дождитесь сообщения преподавателя.'
            : !manifest
              ? 'Приглашение недоступно. Для просмотра или удаления ранее отправленного ответа восстановите личный ключ.'
              : null;
  return (
    <main className="survey-page">
      <header className="survey-topbar">
        <Users size={27} />
        <span>Демографическая мастерская</span>
        <span className="survey-topbar-tag">
          <LockKeyhole size={14} />
          Отдельная форма
        </span>
      </header>
      <div className="survey-content">
        <header className="survey-intro">
          <span className="barrier-eyebrow">Перед общим обсуждением</span>
          <h1>{manifest?.title ?? 'Барьеры и условия родительства'}</h1>
          <p>{manifest?.purpose ?? 'Добровольный опрос участников занятия.'}</p>
        </header>
        <section className="survey-privacy">
          <ShieldCheck size={23} />
          <div>
            <strong>Ответ не связывается с вашим учебным профилем.</strong>
            <p>
              Не указывайте имена и другие узнаваемые подробности. Ответы видит преподаватель;
              на общий экран выводятся только обобщения.
            </p>
            <p>
              Участие добровольное. Один из вопросов можно пропустить.
            </p>
            {manifest ? (
              <p className="barrier-muted">
                Организатор: {manifest.organizerContact}. Хранение до{' '}
                {new Date(manifest.retentionUntil).toLocaleDateString('ru-RU', { timeZone: 'UTC' })}
                .
              </p>
            ) : null}
          </div>
        </section>
        {props.loading ? <Busy>Загружаем опрос…</Busy> : null}
        <TaskMessage error={props.error} />
        {readOnlyReason ? (
          <p className="barrier-feedback" role="status">
            <LockKeyhole size={18} />
            {readOnlyReason}
          </p>
        ) : null}
        {(manifest || submitted) &&
        !withdrawn &&
        response?.availability !== 'expired' &&
        response?.availability !== 'purged' ? (
          <form
            id={formId}
            className="survey-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <fieldset disabled={!canEdit || working} className="survey-section">
              <legend>
                <span>01</span>Ваша перспектива
              </legend>
              <label>
                {manifest?.questions.q00 ?? 'С какой позиции вы отвечаете?'}
                <select
                  required
                  aria-label="С какой позиции вы отвечаете?"
                  value={perspective}
                  onChange={(event) =>
                    choosePerspective(event.target.value as SurveyPerspective | '')
                  }
                >
                  <option value="">Выберите вариант</option>
                  {Object.entries(perspectiveLabels).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {perspective === 'adult_child_inferred' ? (
                <p className="barrier-note">
                  В ответах будет сохранено, что это ваша оценка, а не прямое сообщение взрослого
                  ребёнка.
                </p>
              ) : null}
              {perspective === 'adult_child_reported' ? (
                <p className="barrier-note">
                  Передавайте только то, что взрослый ребёнок сообщал вам сам, без имён и личных
                  подробностей.
                </p>
              ) : null}
              {perspective === 'self' ? (
                <details className="survey-optional-baseline">
                  <summary>Необязательно: планы на ближайшие годы</summary>
                  <div className="barrier-form-columns">
                    <label>
                      {manifest?.questions.q05_12m ??
                        'Планируете ли вы рождение ребёнка в ближайшие 12 месяцев?'}
                      <select
                        aria-label="Намерения на ближайшие 12 месяцев"
                        value={draft.intention12m ?? ''}
                        onChange={(event) =>
                          update('intention12m', (event.target.value as SurveyIntention) || null)
                        }
                      >
                        <option value="">Пропустить вопрос</option>
                        {Object.entries(intentionLabels).map(([key, label]) => (
                          <option value={key} key={key}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {manifest?.questions.q05_36m ??
                        'Планируете ли вы рождение ребёнка в ближайшие 3 года?'}
                      <select
                        aria-label="Намерения на ближайшие 3 года"
                        value={draft.intention36m ?? ''}
                        onChange={(event) =>
                          update('intention36m', (event.target.value as SurveyIntention) || null)
                        }
                      >
                        <option value="">Пропустить вопрос</option>
                        {Object.entries(intentionLabels).map(([key, label]) => (
                          <option value={key} key={key}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </details>
              ) : null}
            </fieldset>
            {perspective && perspective !== 'decline' ? (
              <>
                <fieldset disabled={!canEdit || working} className="survey-section">
                  <legend>
                    <span>02</span>Что затрудняет решение?
                  </legend>
                  <label>
                    {manifest?.questions.q01 ??
                      'Какие обстоятельства затрудняют решение о рождении ребёнка?'}
                    <textarea
                      aria-label="Ответ о барьерах"
                      maxLength={4000}
                      rows={5}
                      value={draft.answerBarrier ?? ''}
                      onChange={(event) => update('answerBarrier', event.target.value || null)}
                      placeholder="Напишите своими словами. Этот вопрос можно пропустить."
                    />
                  </label>
                  <p className="survey-field-hint">
                    До 4 000 знаков · можно пропустить один из двух открытых вопросов.
                  </p>
                </fieldset>
                <fieldset disabled={!canEdit || working} className="survey-section">
                  <legend>
                    <span>03</span>Какие условия могли бы помочь?
                  </legend>
                  <label>
                    {manifest?.questions.q02 ?? 'Какие изменения могли бы изменить ситуацию?'}
                    <textarea
                      aria-label="Ответ об условиях"
                      maxLength={4000}
                      rows={5}
                      value={draft.answerSupport ?? ''}
                      onChange={(event) => update('answerSupport', event.target.value || null)}
                      placeholder="Что именно должно измениться, для кого и при каких условиях?"
                    />
                  </label>
                  <p className="survey-field-hint">
                    Можно описывать любые обстоятельства; ответ не ограничен существующими мерами
                    поддержки.
                  </p>
                </fieldset>
                <section className="survey-extra">
                  <button
                    type="button"
                    className="survey-extra-toggle"
                    aria-expanded={showOptional}
                    onClick={() => setShowOptional(!showOptional)}
                  >
                    <span>
                      <strong>Уточнить условия изменения</strong>
                      <small>Необязательные вопросы для более точного анализа</small>
                    </span>
                    <ChevronDown size={20} />
                  </button>
                  {showOptional ? (
                    <fieldset disabled={!canEdit || working} className="survey-extra-fields">
                      <label>
                        {manifest?.questions.q03 ?? 'Какое одно изменение было бы наиболее важным?'}
                        <textarea
                          aria-label="Приоритетное изменение"
                          maxLength={4000}
                          rows={3}
                          value={draft.priorityChange ?? ''}
                          onChange={(event) => {
                            const value = event.target.value;
                            setDraft((old) => ({
                              ...old,
                              priorityChange: value.trim() ? value : null,
                              priorityConditionId: value.trim() ? randomUuid() : null,
                              conditionalChange: null,
                            }));
                            setDirty(true);
                            setSaved(false);
                          }}
                        />
                      </label>
                      <label>
                        {manifest?.questions.q04 ??
                          'На каком горизонте это могло бы изменить решение?'}
                        <select
                          aria-label="Горизонт изменения"
                          value={draft.horizon ?? ''}
                          onChange={(event) =>
                            update('horizon', (event.target.value as SurveyHorizon) || null)
                          }
                        >
                          <option value="">Пропустить вопрос</option>
                          {Object.entries(horizonLabels).map(([key, label]) => (
                            <option key={key} value={key}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      {perspective === 'self' && draft.priorityChange?.trim() ? (
                        <label>
                          {manifest?.questions.q06 ??
                            'Изменилось бы ваше намерение при выполнении именно этого условия?'}
                          <span className="survey-condition">Условие: {draft.priorityChange}</span>
                          <select
                            aria-label="Изменение собственного намерения"
                            value={draft.conditionalChange ?? ''}
                            onChange={(event) =>
                              update(
                                'conditionalChange',
                                (event.target.value as SurveyConditional) || null,
                              )
                            }
                          >
                            <option value="">Пропустить вопрос</option>
                            {Object.entries(conditionalLabels).map(([key, label]) => (
                              <option value={key} key={key}>
                                {label}
                              </option>
                            ))}
                          </select>
                          <small>
                            При изменении текста условия оценку потребуется дать заново.
                          </small>
                        </label>
                      ) : null}
                      <label>
                        {manifest?.questions.q07 ?? 'Какие дополнительные условия важны?'}
                        <textarea
                          aria-label="Дополнительные условия"
                          maxLength={4000}
                          rows={3}
                          value={draft.additionalConditions ?? ''}
                          onChange={(event) =>
                            update('additionalConditions', event.target.value || null)
                          }
                        />
                      </label>
                    </fieldset>
                  ) : null}
                </section>
              </>
            ) : perspective === 'decline' ? (
              <p className="barrier-note">
                Вы выбрали отказ от содержательных ответов. Если завершить форму, сохранится только
                этот выбор и отметки согласий.
              </p>
            ) : null}
            <fieldset disabled={!canEdit || working} className="survey-section survey-consents">
              <legend>
                <span>04</span>Участие и использование ответов
              </legend>
              {manifest?.questions.q08 ? (
                <p className="barrier-muted">{manifest.questions.q08}</p>
              ) : null}
              <label className="barrier-checkbox">
                <input
                  type="checkbox"
                  required
                  checked={draft.adultConfirmed}
                  onChange={(event) => update('adultConfirmed', event.target.checked)}
                />
                <span>Мне исполнилось 18 лет.</span>
              </label>
              <label className="barrier-checkbox">
                <input
                  type="checkbox"
                  required
                  checked={draft.consentEducational}
                  onChange={(event) => update('consentEducational', event.target.checked)}
                />
                <span>
                  Я добровольно участвую и согласен с использованием ответа для учебного обсуждения
                  в обобщённом виде.
                </span>
              </label>
              <label className="barrier-checkbox">
                <input
                  type="checkbox"
                  checked={draft.consentResearch}
                  onChange={(event) => {
                    setDraft((old) => ({
                      ...old,
                      consentResearch: event.target.checked,
                      consentQuote: event.target.checked ? old.consentQuote : false,
                    }));
                    setDirty(true);
                    setSaved(false);
                  }}
                />
                <span>
                  Дополнительно разрешаю использовать ответ в научном исследовании. Это
                  необязательно и не влияет на участие в занятии.
                </span>
              </label>
              <label className="barrier-checkbox">
                <input
                  type="checkbox"
                  disabled={!draft.consentResearch || !canEdit || working}
                  checked={draft.consentQuote}
                  onChange={(event) => update('consentQuote', event.target.checked)}
                />
                <span>
                  Отдельно разрешаю публиковать обезличенные цитаты из ответа в научных работах.
                  Необязательно; требует согласия на исследование.
                </span>
              </label>
            </fieldset>
            {changed ? (
              <div className="barrier-conflict" role="alert">
                <strong>Сохранённый ответ изменился.</strong>
                <p>
                  Ваш текущий текст остаётся в форме. Перед повторной отправкой сверьте ответ с
                  другого устройства.
                </p>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setRevision(response!.revision)}
                >
                  Использовать новую редакцию и оставить мой текст
                </button>
              </div>
            ) : null}
            <TaskMessage error={validation ?? task.error} />
            {saved && !dirty ? (
              <p className="survey-saved" role="status">
                <Check size={19} />
                Ответ сохранён.
              </p>
            ) : null}
            {canEdit ? (
              <div className="survey-submit">
                <p>ФИО, email и муниципалитет не запрашиваются.</p>
                <button
                  className="button button-primary"
                  type="submit"
                  disabled={working || changed}
                >
                  {working ? 'Сохраняем…' : submitted ? 'Сохранить изменения' : 'Сохранить ответ'}
                </button>
              </div>
            ) : null}
          </form>
        ) : null}
        <details className="survey-receipt" open={!manifest || !manifest.canRespond}>
          <summary>Управление моим ответом</summary>
          <div className="survey-receipt-heading">
            <KeyRound size={23} />
            <div>
              <h2>Личный ключ ответа</h2>
              <p>
                Это единственный способ открыть или удалить ваш ответ с другого устройства. Не
                передавайте ключ другим людям.
              </p>
            </div>
          </div>
          {props.secretPresent ? (
            <>
              <div className="barrier-survey-controls">
                <button
                  className="button button-secondary"
                  onClick={() => setShowSecret(showSecret ? null : props.onRevealSecret())}
                >
                  <Eye size={16} />
                  {showSecret ? 'Скрыть ключ' : 'Показать мой ключ'}
                </button>
                <button className="button button-secondary" onClick={props.onDownloadReceipt}>
                  <Download size={16} />
                  Скачать квитанцию
                </button>
                {submitted ? (
                  <button
                    className="button button-quiet"
                    disabled={working}
                    onClick={() => setWithdrawConfirm(true)}
                  >
                    <Trash2 size={16} />
                    Удалить мой ответ
                  </button>
                ) : null}
              </div>
              {showSecret ? (
                <div className="survey-secret" role="status">
                  <code>{showSecret}</code>
                  <p>Храните вне общего экрана. Ключ не включается в ссылку опроса.</p>
                </div>
              ) : null}
            </>
          ) : null}
          <button
            className="button button-quiet"
            aria-expanded={restoreOpen}
            onClick={() => setRestoreOpen(!restoreOpen)}
          >
            {props.secretPresent
              ? 'Восстановить по другому личному ключу'
              : 'У меня есть личный ключ ответа'}
          </button>
          {restoreOpen ? (
            <form
              className="survey-restore"
              onSubmit={(event) => {
                event.preventDefault();
                void task.run(
                  () => props.onRestoreSecret(restoreSecret.trim()),
                  () => {
                    setDirty(false);
                    setShowSecret(null);
                    setRestoreSecret('');
                    setRestoreOpen(false);
                    setSaved(false);
                  },
                );
              }}
            >
              <label>
                Личный ключ
                <input
                  value={restoreSecret}
                  onChange={(event) => setRestoreSecret(event.target.value)}
                  required
                  minLength={64}
                  maxLength={64}
                  pattern="[a-f0-9]{64}"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  placeholder="64 символа из сохранённой квитанции"
                />
              </label>
              <button className="button button-secondary" disabled={working} type="submit">
                Восстановить доступ к ответу
              </button>
            </form>
          ) : null}
          <TaskMessage error={!canEdit ? task.error : null} />
          <button
            className="button button-quiet"
            disabled={working}
            onClick={() => void task.run(props.onRefresh)}
          >
            <RefreshCw size={15} />
            Обновить состояние
          </button>
        </details>
        <footer className="survey-footer">
          Опрос отражает опыт этой аудитории. Он не устанавливает причинный эффект мер и не
          представляет всё население.
        </footer>
      </div>
      {withdrawConfirm ? (
        <Modal
          title="Удалить мой ответ?"
          onClose={() => setWithdrawConfirm(false)}
          actions={
            <>
              <button className="button button-secondary" onClick={() => setWithdrawConfirm(false)}>
                Отмена
              </button>
              <button
                className="button button-primary"
                disabled={working}
                onClick={() =>
                  void task.run(
                    () => props.onWithdraw(response?.revision ?? revision),
                    (value) => {
                      accept(value);
                      setWithdrawConfirm(false);
                      setShowSecret(null);
                    },
                  )
                }
              >
                Удалить мой ответ без восстановления
              </button>
            </>
          }
        >
          <p>
            Тексты и отметки ответа будут удалены из базы и последующих выгрузок. Старое сохранение
            не сможет восстановить их. Ранее выгруженные материалы находятся у организатора; по ним
            обращайтесь к указанному контакту.
          </p>
          <TaskMessage error={task.error} />
        </Modal>
      ) : null}
    </main>
  );
}

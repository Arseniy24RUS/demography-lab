import { useId, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  GitCompareArrows,
  GripVertical,
  Layers3,
  MoveRight,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { Modal } from '@/components/Modal';
import type { PracticeFamily, SaveFamilyInput } from '../../../../../packages/workshop/types';
import { suggestFamilyPairs } from '../../../../../packages/workshop/analysis';
import { PracticeDetails, VariantComparison } from './PracticeDetails';
import type { VariantView } from './PracticeDetails';
import type { ReadyWorkshopProps } from './workshop-ui';
import { regionName } from './workshop-ui';
import { useWorkshopTask } from './useWorkshopTask';
import { usePracticeDrag } from './usePracticeDrag';

interface TransferIntent {
  ids: string[];
  targetId: string;
  expectedBoardRevision: number;
  target: PracticeFamily | null;
}
interface RemoveIntent {
  family: PracticeFamily;
  variant: VariantView;
  expectedBoardRevision: number;
}

export function FamilyWorkbench({
  session,
  snapshot,
  regions,
  busy,
  actions,
  onOpenSource,
  sharedWorkspace = false,
}: ReadyWorkshopProps) {
  const id = useId();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [form, setForm] = useState<SaveFamilyInput | null>(null);
  const [transfer, setTransfer] = useState<TransferIntent | null>(null);
  const [remove, setRemove] = useState<RemoveIntent | null>(null);
  const [deleting, setDeleting] = useState<{ family: PracticeFamily; revision: number } | null>(
    null,
  );
  const [inspecting, setInspecting] = useState<VariantView | null>(null);
  const [comparing, setComparing] = useState<VariantView[] | null>(null);
  const task = useWorkshopTask();
  const disabled = busy || task.working;
  const host = sharedWorkspace ? session.session.role !== 'observer' : session.session.role === 'host';
  const lockedRound = snapshot.round?.status === 'open';
  const canCurate =
    host &&
    (sharedWorkspace || (session.session.status === 'open' && session.session.phase !== 'discussion')) &&
    !lockedRound;
  const submissions = useMemo(
    () => session.submissions.filter((item) => item.status === 'shared'),
    [session.submissions],
  );
  const variants = useMemo(
    () =>
      new Map<string, VariantView>(
        submissions.map((item) => [
          item.id,
          {
            id: item.id,
            revision: item.revision,
            bundle: item.bundle,
            authorName: item.authorName,
          },
        ]),
      ),
    [submissions],
  );
  const membership = useMemo(
    () =>
      new Map(
        snapshot.families.flatMap((family) =>
          family.submissionIds.map((submissionId) => [submissionId, family] as const),
        ),
      ),
    [snapshot.families],
  );
  const inbox = submissions.filter((item) => !membership.has(item.id));
  const selectedIds = submissions.filter((item) => selected.has(item.id)).map((item) => item.id);
  const selectedVariants = selectedIds
    .map((submissionId) => variants.get(submissionId)!)
    .filter(Boolean);
  const suggestions = useMemo(
    () =>
      suggestFamilyPairs(submissions, 16)
        .filter((pair) => {
          const leftFamily = membership.get(pair.leftId)?.id;
          return !leftFamily || leftFamily !== membership.get(pair.rightId)?.id;
        })
        .slice(0, 8),
    [submissions, membership],
  );
  const hasModal = Boolean(form || transfer || remove || deleting);

  function toggleSelection(submissionId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(submissionId)) next.delete(submissionId);
      else next.add(submissionId);
      return next;
    });
  }

  function showTransfer(ids: string[], targetId = '') {
    task.clearError();
    const target = snapshot.families.find((family) => family.id === targetId) ?? null;
    setTransfer({
      ids,
      targetId: target?.id ?? '',
      target,
      expectedBoardRevision: snapshot.boardRevision,
    });
  }

  const drag = usePracticeDrag(
    (submissionId, familyId) => {
      if (!canCurate || disabled || membership.get(submissionId)?.id === familyId) return;
      showTransfer([submissionId], familyId);
    },
    (submissionId) => {
      if (canCurate && !disabled) showTransfer([submissionId]);
    },
  );

  function openFamilyForm(family?: PracticeFamily) {
    task.clearError();
    setForm({
      familyId: family?.id ?? null,
      expectedBoardRevision: snapshot.boardRevision,
      title: family?.title ?? '',
      mechanism: family?.mechanism ?? '',
      rationale: family?.rationale ?? '',
      submissionIds: family?.submissionIds.slice() ?? selectedIds,
    });
  }

  function isExpanded(family: PracticeFamily) {
    return expanded ? expanded.has(family.id) : snapshot.families[0]?.id === family.id;
  }

  function inspect(variant: VariantView) {
    setComparing(null);
    setInspecting(variant);
  }

  function refreshFormMembers() {
    if (!form) return;
    const family = snapshot.families.find((entry) => entry.id === form.familyId);
    setForm({
      ...form,
      expectedBoardRevision: snapshot.boardRevision,
      submissionIds:
        family?.submissionIds.slice() ??
        form.submissionIds.filter((submissionId) => variants.has(submissionId)),
    });
  }

  const selectedFormVariants = form
    ? form.submissionIds
        .map((submissionId) => variants.get(submissionId))
        .filter((item): item is VariantView => Boolean(item))
    : [];
  const missingFormFamily = Boolean(
    form?.familyId && !snapshot.families.some((family) => family.id === form.familyId),
  );

  return (
    <div className="workshop-family-view">
      <div className="workshop-section-heading">
        <div>
          <h2>Сопоставьте механизмы и сохраните различия</h2>
          <p>Каждый региональный вариант сохраняет условия, авторство и точные цитаты.</p>
        </div>
        {host ? (
          <div className="workshop-selection-actions">
            <span className="workshop-selected-count">
              Выбрано <strong>{selectedIds.length}</strong>
            </span>
            <button
              className="button button-primary"
              disabled={disabled || !canCurate || !selectedIds.length}
              onClick={() => openFamilyForm()}
            >
              <Plus size={17} />
              Создать семейство
            </button>
          </div>
        ) : null}
      </div>
      {host && !canCurate ? (
        <p className="session-message">
          {lockedRound
            ? 'Идёт оценивание зафиксированных версий. Изменить семейства можно после закрытия раунда.'
            : 'Состав семейств меняется при открытом занятии на этапе чтения или проверки.'}
        </p>
      ) : null}
      {!host ? (
        <p className="workshop-method-note">
          Группировку подтверждает преподаватель. Откройте региональные варианты и обсудите сходство
          механизмов и различия условий.
        </p>
      ) : null}
      {task.error && !hasModal ? (
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
      {suggestions.length ? (
        <details className="workshop-suggestions">
          <summary>
            <GitCompareArrows size={17} />
            Пары для содержательного сопоставления <span>{suggestions.length}</span>
          </summary>
          <p className="workshop-muted">
            Подсказки основаны на формулировках и ссылках карточек. Основание объединения проверяет
            преподаватель.
          </p>
          {suggestions.map((pair) => {
            const left = variants.get(pair.leftId),
              right = variants.get(pair.rightId);
            if (!left || !right) return null;
            return (
              <div className="workshop-suggestion-pair" key={`${pair.leftId}:${pair.rightId}`}>
                <div>
                  <strong>{left.bundle.practice.title}</strong>
                  <span>{regionName(regions, left.bundle.practice.regionId)}</span>
                </div>
                <GitCompareArrows size={16} aria-hidden="true" />
                <div>
                  <strong>{right.bundle.practice.title}</strong>
                  <span>{regionName(regions, right.bundle.practice.regionId)}</span>
                </div>
                <button
                  className="button button-secondary"
                  onClick={() => {
                    setSelected(new Set([left.id, right.id]));
                    setComparing([left, right]);
                  }}
                >
                  Сопоставить пару
                </button>
                <p>{pair.reasons.join(' · ')}</p>
              </div>
            );
          })}
        </details>
      ) : null}
      {selectedVariants.length > 0 ? (
        <div className="workshop-selection-strip">
          <p>
            Выбрано для сопоставления: <strong>{selectedVariants.length}</strong>
          </p>
          <div>
            <button
              className="button button-secondary"
              disabled={selectedVariants.length < 2}
              onClick={() => setComparing(selectedVariants)}
            >
              <GitCompareArrows size={16} />
              Сопоставить выбранные
            </button>
            {host && snapshot.families.length ? (
              <button
                className="button button-secondary"
                disabled={disabled || !canCurate}
                onClick={() => showTransfer(selectedIds)}
              >
                <MoveRight size={16} />
                Добавить в семейство
              </button>
            ) : null}
            <button
              className="button button-quiet"
              disabled={task.working}
              onClick={() => setSelected(new Set())}
            >
              Снять выбор
            </button>
          </div>
        </div>
      ) : null}
      <div className="workshop-curation-layout">
        <section className="workshop-inbox" aria-labelledby={`${id}-inbox`}>
          <header className="workshop-column-heading">
            <h3 id={`${id}-inbox`}>
              Без семейства <span>{inbox.length}</span>
            </h3>
            {canCurate ? (
              <p>
                <GripVertical size={14} />
                Перенос доступен и через кнопку
              </p>
            ) : null}
          </header>
          <div className="workshop-inbox-list">
            {inbox.map((submission) => {
              const variant = variants.get(submission.id)!;
              return (
                <article
                  key={submission.id}
                  className="workshop-inbox-item"
                  data-selected={selected.has(submission.id)}
                  data-dragging={drag.drag?.id === submission.id}
                >
                  <div className="workshop-inbox-item-head">
                    {canCurate ? (
                      <button
                        className="workshop-drag-handle"
                        disabled={disabled}
                        aria-label={`Перенести практику «${submission.bundle.practice.title}»`}
                        onPointerDown={(event) =>
                          drag.start(event, submission.id, submission.bundle.practice.title)
                        }
                        onPointerMove={drag.move}
                        onPointerUp={drag.finish}
                        onPointerCancel={drag.cancel}
                        onClick={(event) => drag.click(event, submission.id)}
                      >
                        <GripVertical size={18} />
                      </button>
                    ) : null}
                    <label className="workshop-variant-checkbox">
                      <input
                        type="checkbox"
                        checked={selected.has(submission.id)}
                        onChange={() => toggleSelection(submission.id)}
                      />
                      <span className="session-sr-only">
                        Выбрать практику «{submission.bundle.practice.title}»
                      </span>
                    </label>
                    <span className="workshop-variant-region">
                      {regionName(regions, submission.bundle.practice.regionId)}
                    </span>
                  </div>
                  <h4>{submission.bundle.practice.title}</h4>
                  <p className="workshop-inbox-mechanism">
                    {Array.from(submission.bundle.practice.mechanism).slice(0, 230).join('')}
                    {Array.from(submission.bundle.practice.mechanism).length > 230 ? '…' : ''}
                  </p>
                  <div className="workshop-inbox-item-footer">
                    <span>{submission.authorName}</span>
                    <button className="button button-secondary" onClick={() => inspect(variant)}>
                      Сопоставить
                    </button>
                  </div>
                </article>
              );
            })}
            {!inbox.length ? (
              <div className="workshop-empty workshop-inbox-empty">
                <Layers3 size={28} aria-hidden="true" />
                <h4>
                  {submissions.length ? 'Карточки распределены' : 'Здесь появятся находки группы'}
                </h4>
                <p>
                  {submissions.length
                    ? 'Региональные варианты доступны в семействах. Состав можно пересмотреть до оценивания.'
                    : 'Сначала найдите основание в документе и отправьте карточку в занятие.'}
                </p>
              </div>
            ) : null}
          </div>
        </section>
        <section className="workshop-families" aria-labelledby={`${id}-families`}>
          <header className="workshop-column-heading">
            <h3 id={`${id}-families`}>
              Семейства практик <span>{snapshot.families.length}</span>
            </h3>
          </header>
          {!snapshot.families.length ? (
            <div className="workshop-empty workshop-families-empty">
              <h4>Соберите общий механизм</h4>
              <p>
                Выберите одну или несколько карточек. Сопоставьте получателей, условия и формы
                поддержки, затем сформулируйте основание объединения.
              </p>
              <p className="workshop-muted">
                Совпадение названия само по себе не устанавливает тождество практик.
              </p>
            </div>
          ) : null}
          {snapshot.families.map((family) => {
            const familyVariants = family.submissionIds
              .map((submissionId) => variants.get(submissionId))
              .filter((item): item is VariantView => Boolean(item));
            const open = isExpanded(family);
            return (
              <article
                key={family.id}
                className="workshop-family"
                data-family-drop={canCurate ? family.id : undefined}
                data-drop-active={drag.drag?.over === family.id}
                aria-labelledby={`${id}-family-${family.id}`}
              >
                <header className="workshop-family-heading">
                  <button
                    className="workshop-family-toggle"
                    aria-expanded={open}
                    aria-controls={`${id}-family-body-${family.id}`}
                    onClick={() =>
                      setExpanded((current) => {
                        const next = new Set(
                          current ?? snapshot.families.slice(0, 1).map((entry) => entry.id),
                        );
                        if (open) next.delete(family.id);
                        else next.add(family.id);
                        return next;
                      })
                    }
                  >
                    {open ? <ChevronDown size={19} /> : <ChevronRight size={19} />}
                    <span>
                      <strong id={`${id}-family-${family.id}`}>{family.title}</strong>
                      <small>Региональных вариантов: {familyVariants.length}</small>
                    </span>
                  </button>
                  {host ? (
                    <button
                      className="button button-secondary"
                      disabled={
                        disabled ||
                        !canCurate ||
                        !selectedIds.some(
                          (submissionId) => !family.submissionIds.includes(submissionId),
                        )
                      }
                      onClick={() => showTransfer(selectedIds, family.id)}
                    >
                      <Plus size={15} />
                      Добавить выбранные
                    </button>
                  ) : null}
                </header>
                {open ? (
                  <div className="workshop-family-body" id={`${id}-family-body-${family.id}`}>
                    <div className="workshop-family-mechanism">
                      <strong>Общий механизм</strong>
                      <p>{family.mechanism}</p>
                    </div>
                    <details className="workshop-family-rationale">
                      <summary>Обоснование объединения</summary>
                      <p>{family.rationale}</p>
                    </details>
                    <VariantComparison
                      variants={familyVariants}
                      regions={regions}
                      onInspect={inspect}
                      onOpenSource={onOpenSource}
                      busy={disabled || !canCurate}
                      onMove={host ? (variant) => showTransfer([variant.id]) : undefined}
                      onRemove={
                        host
                          ? (variant) => {
                              task.clearError();
                              setRemove({
                                family,
                                variant,
                                expectedBoardRevision: snapshot.boardRevision,
                              });
                            }
                          : undefined
                      }
                    />
                    <p className="workshop-family-footnote">
                      Региональные условия сохраняются в каждом варианте.
                    </p>
                    {host ? (
                      <footer className="workshop-family-edit-actions">
                        <button
                          className="button button-quiet"
                          disabled={disabled || !canCurate}
                          onClick={() => openFamilyForm(family)}
                          aria-label={`Редактировать семейство «${family.title}»`}
                        >
                          <Pencil size={14} />
                          Редактировать семейство
                        </button>
                        <button
                          className="button button-quiet"
                          disabled={disabled || !canCurate}
                          onClick={() => {
                            task.clearError();
                            setDeleting({ family, revision: snapshot.boardRevision });
                          }}
                          aria-label={`Удалить семейство «${family.title}»`}
                        >
                          <Trash2 size={14} />
                          Удалить группировку
                        </button>
                      </footer>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </section>
      </div>
      <p className="session-sr-only" role="status" aria-live="polite">
        {drag.announcement}
      </p>
      {drag.drag ? (
        <div
          className="workshop-drag-preview"
          aria-hidden="true"
          style={{
            left: Math.max(8, Math.min(drag.drag.x + 16, window.innerWidth - 280)),
            top: Math.max(8, Math.min(drag.drag.y + 16, window.innerHeight - 90)),
          }}
        >
          <GripVertical size={18} />
          <span>{drag.drag.title}</span>
        </div>
      ) : null}

      {form ? (
        <Modal
          title={form.familyId ? 'Редактировать семейство' : 'Создать семейство практик'}
          onClose={() => {
            if (!task.working) {
              setForm(null);
              task.clearError();
            }
          }}
          wide
          actions={
            <>
              <button
                className="button button-secondary"
                disabled={task.working}
                onClick={() => {
                  setForm(null);
                  task.clearError();
                }}
              >
                Отмена
              </button>
              <button
                className="button button-primary"
                disabled={
                  disabled ||
                  !canCurate ||
                  missingFormFamily ||
                  !form.title.trim() ||
                  !form.mechanism.trim() ||
                  !form.rationale.trim() ||
                  (!form.familyId && !form.submissionIds.length)
                }
                onClick={() =>
                  void task.run(
                    () =>
                      actions.saveFamily({
                        ...form,
                        title: form.title.trim(),
                        mechanism: form.mechanism.trim(),
                        rationale: form.rationale.trim(),
                      }),
                    () => {
                      setForm(null);
                      setSelected(new Set());
                    },
                    'Семейство сохранено. Региональные варианты и цитаты остались отдельными.',
                  )
                }
              >
                Сохранить семейство
              </button>
            </>
          }
        >
          <p className="workshop-modal-lead">
            Объединение фиксирует общий механизм. Суммы, получатели и ограничения сохраняются в
            исходных вариантах.
          </p>
          <div className="session-field workshop-modal-field">
            <label htmlFor={`${id}-family-title`}>Название семейства</label>
            <input
              className="session-input"
              id={`${id}-family-title`}
              maxLength={300}
              value={form.title}
              disabled={task.working}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
            />
          </div>
          <div className="session-field">
            <label htmlFor={`${id}-family-mechanism`}>Общий механизм</label>
            <textarea
              className="session-input"
              id={`${id}-family-mechanism`}
              rows={3}
              maxLength={4000}
              value={form.mechanism}
              disabled={task.working}
              onChange={(event) => setForm({ ...form, mechanism: event.target.value })}
            />
          </div>
          <div className="session-field">
            <label htmlFor={`${id}-family-rationale`}>Обоснование объединения</label>
            <textarea
              className="session-input"
              id={`${id}-family-rationale`}
              rows={3}
              maxLength={4000}
              value={form.rationale}
              disabled={task.working}
              onChange={(event) => setForm({ ...form, rationale: event.target.value })}
            />
            <p className="workshop-muted">
              Что позволяет рассматривать варианты совместно? Какие различия необходимо учитывать
              при адаптации?
            </p>
          </div>
          <div className="workshop-modal-variants">
            <h3>Сохраняемые региональные варианты</h3>
            {selectedFormVariants.map((variant) => (
              <p key={variant.id}>
                <strong>{regionName(regions, variant.bundle.practice.regionId)}</strong> ·{' '}
                {variant.bundle.practice.title}
                {membership.has(variant.id) && membership.get(variant.id)?.id !== form.familyId
                  ? ` · будет перенесена из «${membership.get(variant.id)!.title}»`
                  : ''}
              </p>
            ))}
            {!selectedFormVariants.length ? (
              <p className="workshop-muted">В семействе пока нет действующих вариантов.</p>
            ) : null}
          </div>
          {missingFormFamily ? (
            <p className="workshop-inline-warning">
              Семейство удалено в другом окне. Ваши формулировки остались в форме; скопируйте их
              перед закрытием.
            </p>
          ) : snapshot.boardRevision !== form.expectedBoardRevision ? (
            <div className="workshop-inline-warning">
              <p>
                Состав доски изменился. Текст формы сохранён. Загрузите текущий состав перед
                повторным сохранением.
              </p>
              <button
                className="button button-secondary"
                disabled={task.working}
                onClick={refreshFormMembers}
              >
                Обновить состав, сохранив текст
              </button>
            </div>
          ) : null}
          {task.error ? (
            <p className="session-message" data-tone="error" role="alert">
              {task.error}
            </p>
          ) : null}
        </Modal>
      ) : null}

      {transfer ? (
        <Modal
          title="Добавить практики в семейство"
          onClose={() => {
            if (!task.working) {
              setTransfer(null);
              task.clearError();
            }
          }}
          wide
          actions={
            <>
              <button
                className="button button-secondary"
                disabled={task.working}
                onClick={() => {
                  setTransfer(null);
                  task.clearError();
                }}
              >
                Отмена
              </button>
              <button
                className="button button-primary"
                disabled={disabled || !canCurate || !transfer.target || !transfer.ids.length}
                onClick={() => {
                  const target = transfer.target;
                  if (!target) return;
                  void task.run(
                    () =>
                      actions.saveFamily({
                        familyId: target.id,
                        title: target.title,
                        mechanism: target.mechanism,
                        rationale: target.rationale,
                        expectedBoardRevision: transfer.expectedBoardRevision,
                        submissionIds: [...new Set([...target.submissionIds, ...transfer.ids])],
                      }),
                    () => {
                      setTransfer(null);
                      setSelected(new Set());
                      setExpanded((value) => new Set([...(value ?? []), target.id]));
                    },
                    'Состав семейства обновлён. Источники каждого варианта сохранены.',
                  );
                }}
              >
                Подтвердить перенос
              </button>
            </>
          }
        >
          <p className="workshop-modal-lead">
            Проверьте, соответствует ли общий механизм выбранным практикам. Перенос сохраняет каждую
            исходную карточку.
          </p>
          <div className="session-field workshop-modal-field">
            <label htmlFor={`${id}-transfer-target`}>Семейство назначения</label>
            <select
              className="session-input"
              id={`${id}-transfer-target`}
              value={transfer.targetId}
              disabled={task.working}
              onChange={(event) => showTransfer(transfer.ids, event.target.value)}
            >
              <option value="">Выберите семейство</option>
              {snapshot.families.map((family) => (
                <option value={family.id} key={family.id}>
                  {family.title}
                </option>
              ))}
            </select>
          </div>
          {transfer.target ? (
            <div className="workshop-transfer-mechanism">
              <strong>Общий механизм</strong>
              <p>{transfer.target.mechanism}</p>
              <details>
                <summary>Обоснование</summary>
                <p>{transfer.target.rationale}</p>
              </details>
            </div>
          ) : null}
          <div className="workshop-modal-variants">
            {transfer.ids.map((submissionId) => {
              const variant = variants.get(submissionId);
              if (!variant)
                return (
                  <p key={submissionId} className="workshop-inline-warning">
                    Одна из выбранных публикаций снята с доски.
                  </p>
                );
              return (
                <details key={submissionId}>
                  <summary>
                    {regionName(regions, variant.bundle.practice.regionId)} ·{' '}
                    {variant.bundle.practice.title}
                  </summary>
                  <p>{variant.bundle.practice.mechanism}</p>
                  <p>
                    <strong>Получатели:</strong>{' '}
                    {variant.bundle.practice.eligibility || 'Не указано в карточке'}
                  </p>
                  <p>
                    <strong>Размер:</strong>{' '}
                    {variant.bundle.practice.amount || 'Не указано в карточке'}
                  </p>
                  <p>
                    <strong>Условия:</strong>{' '}
                    {variant.bundle.practice.conditions?.join('; ') || 'Не указано в карточке'}
                  </p>
                  {membership.has(submissionId) ? (
                    <p className="workshop-muted">
                      Текущее семейство: {membership.get(submissionId)!.title}
                    </p>
                  ) : null}
                </details>
              );
            })}
          </div>
          {snapshot.boardRevision !== transfer.expectedBoardRevision ? (
            <div className="workshop-inline-warning">
              <p>Состав доски изменился после выбора. Проверьте актуальный состав назначения.</p>
              <button
                className="button button-secondary"
                disabled={task.working}
                onClick={() => showTransfer(transfer.ids, transfer.targetId)}
              >
                Обновить состав
              </button>
            </div>
          ) : null}
          {task.error ? (
            <p className="session-message" data-tone="error" role="alert">
              {task.error}
            </p>
          ) : null}
        </Modal>
      ) : null}

      {remove ? (
        <Modal
          title="Исключить вариант из семейства"
          onClose={() => {
            if (!task.working) {
              setRemove(null);
              task.clearError();
            }
          }}
          actions={
            <>
              <button
                className="button button-secondary"
                disabled={task.working}
                onClick={() => {
                  setRemove(null);
                  task.clearError();
                }}
              >
                Отмена
              </button>
              <button
                className="button button-primary"
                disabled={disabled || !canCurate}
                onClick={() =>
                  void task.run(
                    () =>
                      actions.saveFamily({
                        familyId: remove.family.id,
                        title: remove.family.title,
                        mechanism: remove.family.mechanism,
                        rationale: remove.family.rationale,
                        expectedBoardRevision: remove.expectedBoardRevision,
                        submissionIds: remove.family.submissionIds.filter(
                          (submissionId) => submissionId !== remove.variant.id,
                        ),
                      }),
                    () => setRemove(null),
                    'Вариант возвращён в список «Без семейства».',
                  )
                }
              >
                Исключить из семейства
              </button>
            </>
          }
        >
          <p className="workshop-modal-lead">{remove.variant.bundle.practice.title}</p>
          <p>
            Практика будет возвращена в список «Без семейства». Её содержание и точные цитаты
            сохранятся.
          </p>
          {task.error ? (
            <p className="session-message workshop-modal-field" data-tone="error" role="alert">
              {task.error}
            </p>
          ) : null}
        </Modal>
      ) : null}

      {deleting ? (
        <Modal
          title="Удалить группировку"
          onClose={() => {
            if (!task.working) {
              setDeleting(null);
              task.clearError();
            }
          }}
          actions={
            <>
              <button
                className="button button-secondary"
                disabled={task.working}
                onClick={() => {
                  setDeleting(null);
                  task.clearError();
                }}
              >
                Отмена
              </button>
              <button
                className="button button-danger"
                disabled={disabled || !canCurate}
                onClick={() =>
                  void task.run(
                    () => actions.deleteFamily(deleting.family.id, deleting.revision),
                    () => setDeleting(null),
                    'Группировка удалена. Исходные карточки доступны на общей доске.',
                  )
                }
              >
                Удалить группировку
              </button>
            </>
          }
        >
          <p className="workshop-modal-lead">{deleting.family.title}</p>
          <p>
            Региональные варианты вернутся в список «Без семейства». Завершённые раунды сохраняют
            прежний состав и полученные оценки.
          </p>
          {task.error ? (
            <p className="session-message workshop-modal-field" data-tone="error" role="alert">
              {task.error}
            </p>
          ) : null}
        </Modal>
      ) : null}

      {inspecting ? (
        <PracticeDetails
          key={inspecting.id}
          variant={inspecting}
          regions={regions}
          onOpenSource={onOpenSource}
          onClose={() => setInspecting(null)}
        />
      ) : null}
      {comparing ? (
        <Modal title="Сопоставление выбранных практик" onClose={() => setComparing(null)} wide>
          <p className="workshop-modal-lead">
            Сравните механизм, получателей, размеры и условия до объединения. Неуказанные сведения
            остаются явно обозначенными.
          </p>
          <VariantComparison
            variants={comparing}
            regions={regions}
            onInspect={inspect}
            onOpenSource={onOpenSource}
          />
        </Modal>
      ) : null}
    </div>
  );
}

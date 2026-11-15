import { useId, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { randomUuid } from '../../../../../packages/security/crypto.mjs';
import { roadmapPassportDataSchema } from '../../../../../packages/roadmaps/schema';
import {
  roadmapSmartCriteria,
  type RoadmapItem,
  type RoadmapPassportData,
  type RoadmapSmartCriterion,
} from '../../../../../packages/roadmaps/types';
import { activeItems, saveInput, SectionHeading, useRoadmapTask } from './common';
import type { RoadmapWorkspaceProps } from './common';
import './passport-workbench.css';

const levels = {
  municipality: 'Муниципальный',
  region: 'Региональный',
  federal: 'Федеральный',
};

const smartHints: Record<RoadmapSmartCriterion, [string, string]> = {
  specific: ['Конкретная', 'Указано, что изменится и для какой группы.'],
  measurable: ['Измеримая', 'Есть показатель, исходное и целевое значения.'],
  achievable: ['Достижимая', 'Команде хватит полномочий, времени и ресурсов.'],
  relevant: ['Значимая', 'Ожидаемое изменение отвечает на проблему выбранной группы.'],
  timeBound: ['Ограничена сроком', 'Названа дата, к которой можно проверить результат.'],
};

function TextField({ label, value, onChange, hint, singleLine }: {
  label: string;
  value: string;
  onChange(value: string): void;
  hint?: string;
  singleLine?: boolean;
}) {
  const id = useId();
  const attributes = {
    id,
    value,
    maxLength: singleLine ? 240 : 4000,
    autoComplete: 'off',
    'aria-describedby': hint ? `${id}-hint` : undefined,
  };
  return <div className="rm-field">
    <label htmlFor={id}>{label}</label>
    {singleLine ? (
      <input {...attributes} onChange={(event) => onChange(event.target.value)} />
    ) : (
      <textarea {...attributes} rows={3} onChange={(event) => onChange(event.target.value)} />
    )}
    {hint ? <small id={`${id}-hint`}>{hint}</small> : null}
  </div>;
}

function DateField({ label, value, onChange }: {
  label: string;
  value: string | null;
  onChange(value: string | null): void;
}) {
  return <label className="rm-field">
    <span>{label}</span>
    <input type="date" min="1900-01-01" max="2200-12-31" value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)} />
  </label>;
}

function PassportForm({ item, snapshot, controller, editable }: Omit<RoadmapWorkspaceProps, 'onEdit'> & {
  item: RoadmapItem<'passport'>;
}) {
  const task = useRoadmapTask();
  const [draft, setDraft] = useState<{ revision: number; data: RoadmapPassportData } | null>(null);
  const data = draft?.data ?? item.data;
  const changedByTeam = draft !== null && draft.revision !== item.revision;
  const disabled = !editable || task.working || controller.busy;

  function update(changes: Partial<RoadmapPassportData>) {
    setDraft((previous) => ({
      revision: previous?.revision ?? item.revision,
      data: { ...(previous?.data ?? item.data), ...changes },
    }));
  }

  function toggleCriterion(criterion: RoadmapSmartCriterion, checked: boolean) {
    const selected = new Set(data.smartChecks);
    if (checked) selected.add(criterion);
    else selected.delete(criterion);
    update({ smartChecks: roadmapSmartCriteria.filter((key) => selected.has(key)) });
  }

  async function save() {
    if (!draft || disabled || changedByTeam) return;
    await task.run(async () => {
      const parsed = roadmapPassportDataSchema.safeParse(draft.data);
      if (!parsed.success)
        throw new Error('Проверьте заполненные поля. Для периода нужны обе даты, начало должно быть не позднее окончания.');
      try {
        await controller.actions.saveItem(saveInput(snapshot.roadmapId, item, parsed.data));
        setDraft(null);
      } catch (cause) {
        void controller.actions.refresh();
        throw cause;
      }
    }, 'Паспорт сохранён.');
  }

  return <form className="rm-passport-form" aria-label="Паспорт проекта" onSubmit={(event) => {
    event.preventDefault();
    void save();
  }}>
    <fieldset disabled={disabled} className="rm-passport-fields">
      <div className="rm-passport-card">
        <div className="rm-passport-level"><span>Уровень проекта</span> <strong>{levels[snapshot.territory.level]}</strong></div>
        <TextField label="Название проекта" singleLine value={data.title} onChange={(title) => update({ title })}
          hint="Кратко назовите проект и отразите его связь с территорией и семьями." />
        <div className="rm-form-grid">
          <TextField label="Целевая группа" value={data.targetGroup} onChange={(targetGroup) => update({ targetGroup })}
            hint="Например, молодые семьи с детьми до трёх лет или многодетные семьи." />
          <TextField label="Партнёры" value={data.partners} onChange={(partners) => update({ partners })}
            hint="Укажите, кто и чем поможет. Это могут быть соцзащита, школы, поликлиники и работодатели." />
        </div>
      </div>

      <div className="rm-passport-card">
        <TextField label="Цель проекта" value={data.goal} onChange={(goal) => update({ goal, smartChecks: [] })}
          hint="Сформулируйте одну цель. Укажите, для кого, что и к какому сроку должно измениться." />
        <fieldset className="rm-passport-smart" disabled={!data.goal.trim()}>
          <legend>Самопроверка цели по SMART</legend>
          {roadmapSmartCriteria.map((criterion) => <label key={criterion} className="rm-passport-criterion">
            <input type="checkbox" checked={data.smartChecks?.includes(criterion) ?? false}
              onChange={(event) => toggleCriterion(criterion, event.target.checked)} />
            <span><strong>{smartHints[criterion][0]}</strong> {smartHints[criterion][1]}</span>
          </label>)}
        </fieldset>

        <fieldset className="rm-array rm-passport-objectives">
          <legend>Задачи проекта</legend>
          <p className="rm-muted">Обычно достаточно трёх или четырёх задач. Опишите шаги, которые ведут к цели.</p>
          {data.objectives.map((objective, index) => <div className="rm-array-row" key={objective.id}>
            <input aria-label={`Задача ${index + 1}`} maxLength={1000} value={objective.title}
              onChange={(event) => update({
                objectives: data.objectives.map((row) => row.id === objective.id
                  ? { ...row, title: event.target.value }
                  : row),
              })} />
            {editable ? <button type="button" className="icon-button" aria-label={`Удалить задачу ${index + 1}`}
              onClick={() => update({ objectives: data.objectives.filter((row) => row.id !== objective.id) })}>
              <Trash2 size={16} aria-hidden="true" />
            </button> : null}
          </div>)}
          {editable ? <button type="button" className="button button-secondary" disabled={data.objectives.length >= 30}
            onClick={() => update({ objectives: [...data.objectives, { id: randomUuid(), title: '' }] })}>
            <Plus size={16} aria-hidden="true" /> Добавить задачу
          </button> : null}
        </fieldset>

        <TextField label="Ожидаемый результат" value={data.expectedResult}
          onChange={(expectedResult) => update({ expectedResult })}
          hint="Опишите, что изменится для семей и по каким результатам это можно увидеть." />
      </div>

      <div className="rm-passport-card">
        <h4>Сроки и ресурсы</h4>
        <div className="rm-form-grid">
          <DateField label="Начало проекта" value={data.startDate} onChange={(startDate) => update({ startDate })} />
          <DateField label="Окончание проекта" value={data.endDate} onChange={(endDate) => update({ endDate })} />
        </div>
        <div className="rm-form-grid">
          <TextField label="Кадровые ресурсы" value={data.humanResources}
            onChange={(humanResources) => update({ humanResources })}
            hint="Специалисты, координаторы и волонтёры, которых можно привлечь." />
          <TextField label="Материальные ресурсы" value={data.materialResources}
            onChange={(materialResources) => update({ materialResources })}
            hint="Помещения, транспорт и оборудование, нужные для работы." />
          <TextField label="Информационные ресурсы" value={data.informationResources}
            onChange={(informationResources) => update({ informationResources })}
            hint="Сайт, социальные сети, СМИ или другие способы связи с семьями." />
        </div>
      </div>
    </fieldset>

    {changedByTeam ? <div className="session-message" data-tone="error" role="alert">
      <p>Команда сохранила новую редакцию паспорта. До загрузки изменений ваш текст доступен для копирования.</p>
      <button className="button button-secondary" type="button" disabled={disabled}
        onClick={() => setDraft(null)}>Загрузить паспорт команды</button>
    </div> : null}
    {task.feedback}
    {editable ? <button className="button button-primary" type="submit" disabled={disabled || !draft || changedByTeam}>
      {task.working ? 'Сохраняем…' : 'Сохранить паспорт'}
    </button> : null}
  </form>;
}

export function PassportWorkbench(props: Omit<RoadmapWorkspaceProps, 'onEdit'>) {
  const item = activeItems(props.snapshot, 'passport')[0];
  return <section className="rm-section rm-passport-workbench">
    <SectionHeading title="Паспорт проекта" />
    {item ? <PassportForm key={item.id} {...props} item={item} /> : <p className="rm-empty">Паспорт недоступен.</p>}
  </section>;
}

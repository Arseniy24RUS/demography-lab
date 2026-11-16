import { activeItems, EditButton, SectionHeading } from './common';
import type { RoadmapWorkspaceProps } from './common';

export function OrganizationDiagnosis({ snapshot, editable, onEdit }: RoadmapWorkspaceProps) {
  const diagnosis = activeItems(snapshot, 'diagnosis')[0];
  return <section className="rm-section" aria-label="Исходная ситуация организации">
    <SectionHeading title="Исходная ситуация и проблема" />
    {diagnosis ? <article>
      <dl className="rm-resource-description">
        <div><dt>Приоритетная проблема</dt><dd>{diagnosis.data.problem || 'Не описана'}</dd></div>
        <div><dt>Гипотеза о причинах</dt><dd>{diagnosis.data.causeHypothesis || 'Не сформулирована'}</dd></div>
        <div><dt>Вывод для проекта</dt><dd>{diagnosis.data.conclusion || 'Не сформулирован'}</dd></div>
      </dl>
      {editable ? <EditButton label="Редактировать обоснование" onClick={() => onEdit({ kind: 'diagnosis', id: diagnosis.id })} /> : null}
    </article> : <p className="rm-empty">Обоснование проекта недоступно.</p>}
  </section>;
}

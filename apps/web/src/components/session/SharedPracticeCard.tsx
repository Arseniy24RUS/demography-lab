import { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  MapPin,
  Monitor,
  Pencil,
  RotateCcw,
  X,
} from 'lucide-react';
import type { TextAnchor } from '@domain/index';
import { anchorQuote, fieldLabels, fieldValue } from '@/lib/workspace-domain';
import type { SharedSubmission } from '../../../../../packages/collaboration/types';
import { dateLabel, initials } from './session-ui';

export function SharedPracticeCard({
  submission,
  regionName,
  busy,
  focused,
  onOpenSource,
  onFocus,
  onWithdraw,
  onRestore,
  onEdit,
}: {
  submission: SharedSubmission;
  regionName: string;
  busy: boolean;
  focused: boolean;
  onOpenSource: (anchor: TextAnchor) => void;
  onFocus?: () => void;
  onWithdraw?: () => void;
  onRestore?: () => void;
  onEdit?: () => void;
}) {
  const [expandedQuotes, setExpandedQuotes] = useState<Set<string>>(new Set());
  const { bundle } = submission;
  const { practice } = bundle;
  const [selectedQuoteId, setSelectedQuoteId] = useState(bundle.occurrences[0]?.id ?? '');
  const activeQuoteId = bundle.occurrences.some((entry) => entry.id === selectedQuoteId)
    ? selectedQuoteId
    : bundle.occurrences[0]?.id;
  const fields = [
    ['Получатели', practice.eligibility],
    ['Размер и объём', practice.amount],
    ['Условия', practice.conditions?.join('\n')],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  return (
    <article
      className="session-practice"
      aria-labelledby={`shared-practice-${submission.id}`}
      data-submission-id={submission.id}
    >
      <header className="session-practice-header">
        <div className="session-practice-context">
          <span>
            <MapPin size={13} aria-hidden="true" />
            {regionName}
          </span>
          {submission.status === 'withdrawn' ? <span>Снята с доски</span> : null}
          {focused ? (
            <span>
              <Monitor size={13} aria-hidden="true" />
              На проекторе
            </span>
          ) : null}
        </div>
      </header>
      <div className="session-practice-content">
        <h3 id={`shared-practice-${submission.id}`}>{practice.title}</h3>
        <p>{practice.mechanism}</p>
        {fields.length ? (
          <dl className="session-practice-fields">
            {fields.flatMap(([label, value]) => [
              <dt key={`${label}-label`}>{label}</dt>,
              <dd key={label}>{value}</dd>,
            ])}
          </dl>
        ) : null}
      </div>
      <section className="session-practice-sources" aria-label="Документальные основания">
        <h4>
          {bundle.occurrences.length === 1
            ? 'Документальное основание'
            : `Документальные основания · ${bundle.occurrences.length}`}
        </h4>
        {bundle.occurrences.length > 1 ? (
          <div
            className="session-quote-selectors"
            role="group"
            aria-label="Выбрать документальное основание"
          >
            {bundle.occurrences.map((occurrence, index) => {
              const labels = [
                ...new Set(
                  (practice.evidence ?? [])
                    .filter(
                      (entry) => entry.kind === 'fragment' && entry.occurrenceId === occurrence.id,
                    )
                    .map((entry) => (entry.kind === 'fragment' ? fieldLabels[entry.field] : '')),
                ),
              ].filter(Boolean);
              return (
                <button
                  key={occurrence.id}
                  className="session-quote-selector"
                  aria-pressed={activeQuoteId === occurrence.id}
                  onClick={() => setSelectedQuoteId(occurrence.id)}
                >
                  {index + 1}. {labels.length ? labels.join(', ') : 'Цитата'}
                </button>
              );
            })}
          </div>
        ) : null}
        {bundle.occurrences
          .filter((occurrence) => occurrence.id === activeQuoteId)
          .map((occurrence) => {
            const source = bundle.sources.find(
              (entry) =>
                entry.sourceId === occurrence.documentId &&
                entry.editionId === occurrence.versionId,
            );
            const quote = anchorQuote(occurrence.anchor);
            const long = Array.from(quote).length > 380;
            const expanded = expandedQuotes.has(occurrence.id);
            const excerpt =
              long && !expanded ? `${Array.from(quote).slice(0, 380).join('')}…` : quote;
            const evidence = (practice.evidence ?? []).filter(
              (entry) => entry.kind === 'fragment' && entry.occurrenceId === occurrence.id,
            );
            return (
              <div className="session-quote" key={occurrence.id}>
                <blockquote>{excerpt}</blockquote>
                {long ? (
                  <button
                    className="button button-quiet"
                    aria-expanded={expanded}
                    onClick={() =>
                      setExpandedQuotes((current) => {
                        const next = new Set(current);
                        if (expanded) next.delete(occurrence.id);
                        else next.add(occurrence.id);
                        return next;
                      })
                    }
                  >
                    {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                    {expanded ? 'Свернуть цитату' : 'Показать цитату целиком'}
                  </button>
                ) : null}
                <div className="session-quote-source">
                  <p>
                    {source?.title ?? 'Региональная программа'}
                    <br />
                    Точная редакция сохранена вместе с фрагментом.
                  </p>
                  <button
                    className="button button-secondary"
                    onClick={() => onOpenSource(occurrence.anchor)}
                  >
                    <ExternalLink size={14} />
                    Открыть цитату
                  </button>
                </div>
                {evidence.length ? (
                  <p className="session-evidence-note">
                    Сопоставление автора:{' '}
                    {evidence
                      .map((entry) => {
                        if (entry.kind !== 'fragment') return '';
                        const reviewed =
                          entry.reviewStatus === 'verified' &&
                          entry.reviewedValue === fieldValue(practice, entry.field);
                        const relation = !reviewed
                          ? 'требует проверки'
                          : entry.relation === 'supports'
                            ? 'подтверждает'
                            : entry.relation === 'partial'
                              ? 'подтверждает частично'
                              : 'выявляет противоречие';
                        return `${fieldLabels[entry.field].toLocaleLowerCase('ru')} — ${relation}`;
                      })
                      .join('; ')}
                    .
                  </p>
                ) : (
                  <p className="session-evidence-note">
                    Сопоставление отдельных полей с этой цитатой не указано.
                  </p>
                )}
              </div>
            );
          })}
        {!bundle.occurrences.length ? (
          <p className="session-evidence-note">
            В публикации пока нет точных цитат. Содержание требует сопоставления с документом.
          </p>
        ) : null}
        {bundle.note ? (
          <div className="session-public-note">
            <strong>Комментарий автора</strong>
            <p>{bundle.note}</p>
          </div>
        ) : null}
      </section>
      <footer className="session-practice-footer">
        <div className="session-person">
          <span className="session-avatar" aria-hidden="true">
            {initials(submission.authorName)}
          </span>
          <div>
            <strong>{submission.authorName}</strong>
            <small>
              <time dateTime={submission.updatedAt}>{dateLabel(submission.updatedAt)}</time>
              {submission.revision > 1 ? ' · обновлено' : ''}
            </small>
          </div>
        </div>
        <div className="session-action-row">
          {onEdit ? (
            <button className="button button-quiet" disabled={busy} onClick={onEdit}>
              <Pencil size={15} />
              Редактировать
            </button>
          ) : null}
          {onFocus ? (
            <button
              className="button button-secondary"
              disabled={busy}
              aria-pressed={focused}
              onClick={onFocus}
            >
              <Monitor size={15} />
              {focused ? 'Убрать с проектора' : 'Показать на проекторе'}
            </button>
          ) : null}
          {onWithdraw ? (
            <button className="button button-quiet" disabled={busy} onClick={onWithdraw}>
              <X size={15} />
              Снять с доски
            </button>
          ) : null}
          {onRestore ? (
            <button className="button button-secondary" disabled={busy} onClick={onRestore}>
              <RotateCcw size={15} />
              Вернуть на доску
            </button>
          ) : null}
        </div>
      </footer>
    </article>
  );
}

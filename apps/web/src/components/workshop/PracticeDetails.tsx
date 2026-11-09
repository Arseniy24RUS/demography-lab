import { useState } from 'react';
import { ArrowUpRight, ChevronDown, ChevronUp } from 'lucide-react';
import type { TextAnchor } from '@domain/index';
import type { SharedPracticeBundle } from '../../../../../packages/collaboration/types';
import { anchorQuote, fieldLabels, fieldValue } from '@/lib/workspace-domain';
import { Modal } from '@/components/Modal';
import type { WorkshopRegionOption } from './workshop-ui';
import { regionName } from './workshop-ui';

export interface VariantView {
  id: string;
  revision: number;
  bundle: SharedPracticeBundle;
  authorName?: string;
}

export function ExpandableText({
  text,
  limit = 190,
}: {
  text: string | null | undefined;
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!text?.trim()) return <span className="workshop-missing-field">Не указано в карточке</span>;
  const points = Array.from(text);
  const long = points.length > limit;
  return (
    <div className="workshop-expandable-text">
      <p>{expanded || !long ? text : `${points.slice(0, limit).join('')}…`}</p>
      {long ? (
        <button
          className="button button-quiet"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Свернуть' : 'Показать полностью'}
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      ) : null}
    </div>
  );
}

export function PracticeDetails({
  variant,
  regions,
  onOpenSource,
  onClose,
}: {
  variant: VariantView;
  regions: WorkshopRegionOption[];
  onOpenSource: (anchor: TextAnchor) => void;
  onClose: () => void;
}) {
  const { bundle } = variant;
  const { practice } = bundle;
  const [quoteId, setQuoteId] = useState(bundle.occurrences[0]?.id ?? '');
  const quote =
    bundle.occurrences.find((occurrence) => occurrence.id === quoteId) ?? bundle.occurrences[0];
  const source = bundle.sources.find(
    (entry) => entry.sourceId === quote?.documentId && entry.editionId === quote?.versionId,
  );
  const evidence = (practice.evidence ?? []).filter(
    (entry) => entry.kind === 'fragment' && entry.occurrenceId === quote?.id,
  );
  return (
    <Modal title={practice.title} onClose={onClose} wide>
      <div className="workshop-practice-detail">
        <div className="workshop-detail-meta">
          <span>{regionName(regions, practice.regionId)}</span>
          <span>Редакция карточки {variant.revision}</span>
          {variant.authorName ? <span>{variant.authorName}</span> : null}
        </div>
        <dl className="workshop-detail-fields">
          <dt>Механизм</dt>
          <dd>{practice.mechanism}</dd>
          <dt>Получатели</dt>
          <dd>{practice.eligibility?.trim() || 'Не указано в карточке'}</dd>
          <dt>Размер и объём</dt>
          <dd>{practice.amount?.trim() || 'Не указано в карточке'}</dd>
          <dt>Условия</dt>
          <dd>
            {practice.conditions?.length ? practice.conditions.join('\n') : 'Не указано в карточке'}
          </dd>
        </dl>
        <section
          className="workshop-evidence-section"
          aria-label="Точные основания регионального варианта"
        >
          <h3>Основания в документе</h3>
          <p className="workshop-muted">
            Текст цитаты и редакция источника сохранены с карточкой. Содержательное сопоставление
            полей выполняет автор.
          </p>
          <div className="workshop-quote-selectors" role="group" aria-label="Выбрать цитату">
            {bundle.occurrences.map((occurrence, index) => {
              const fields = [
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
                  className="session-quote-selector"
                  key={occurrence.id}
                  aria-pressed={quote?.id === occurrence.id}
                  onClick={() => setQuoteId(occurrence.id)}
                >
                  {index + 1}. {fields.join(', ') || 'Цитата'}
                </button>
              );
            })}
          </div>
          {quote ? (
            <div className="workshop-detail-quote">
              <blockquote>{anchorQuote(quote.anchor)}</blockquote>
              <p className="workshop-quote-source-title">
                {source?.title ?? 'Региональная программа'}
              </p>
              <button
                className="button button-secondary"
                onClick={() => onOpenSource(quote.anchor)}
              >
                <ArrowUpRight size={15} />
                Открыть цитату в документе
              </button>
              {evidence.length ? (
                <div className="workshop-field-evidence">
                  {evidence.map((entry, index) => {
                    if (entry.kind !== 'fragment') return null;
                    const current =
                      entry.reviewStatus === 'verified' &&
                      entry.reviewedValue === fieldValue(practice, entry.field);
                    return (
                      <p key={`${entry.field}-${index}`}>
                        <strong>{fieldLabels[entry.field]}:</strong>{' '}
                        {!current
                          ? 'сопоставление требует проверки'
                          : entry.relation === 'supports'
                            ? 'автор подтвердил соответствие'
                            : entry.relation === 'partial'
                              ? 'автор указал частичное соответствие'
                              : 'автор отметил противоречие'}
                        .{entry.note ? ` ${entry.note}` : ''}
                      </p>
                    );
                  })}
                </div>
              ) : (
                <p className="workshop-muted">
                  Сопоставление отдельных полей с этой цитатой не указано.
                </p>
              )}
            </div>
          ) : (
            <p className="workshop-inline-warning">
              Точная цитата недоступна в сохранённом варианте.
            </p>
          )}
        </section>
        {bundle.note ? (
          <div className="workshop-author-note">
            <strong>Комментарий к публикации</strong>
            <p>{bundle.note}</p>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export function VariantComparison({
  variants,
  regions,
  onInspect,
  onOpenSource,
  onMove,
  onRemove,
  busy = false,
}: {
  variants: VariantView[];
  regions: WorkshopRegionOption[];
  onInspect: (variant: VariantView) => void;
  onOpenSource: (anchor: TextAnchor) => void;
  onMove?: (variant: VariantView) => void;
  onRemove?: (variant: VariantView) => void;
  busy?: boolean;
}) {
  if (!variants.length)
    return (
      <p className="workshop-muted workshop-list-empty">
        В семействе пока нет действующих публикаций. Добавьте региональный вариант с общей доски.
      </p>
    );
  return (
    <div className="workshop-comparison-wrap">
      <table className="workshop-comparison">
        <caption className="session-sr-only">
          Региональные варианты с сохранением условий и документальных оснований
        </caption>
        <thead>
          <tr>
            <th scope="col">Регион и практика</th>
            <th scope="col">Получатели</th>
            <th scope="col">Размер и условия</th>
            <th scope="col">Основания</th>
          </tr>
        </thead>
        <tbody>
          {variants.map((variant) => {
            const practice = variant.bundle.practice;
            const firstQuote = variant.bundle.occurrences[0];
            return (
              <tr key={variant.id}>
                <th scope="row" data-label="Регион и практика">
                  <span className="workshop-variant-region">
                    {regionName(regions, practice.regionId)}
                  </span>
                  <strong>{practice.title}</strong>
                  {variant.authorName ? <small>{variant.authorName}</small> : null}
                  <button className="button button-quiet" onClick={() => onInspect(variant)}>
                    Содержание и цитаты
                  </button>
                  {onMove || onRemove ? (
                    <div className="workshop-variant-edit-actions">
                      {onMove ? (
                        <button
                          className="button button-quiet"
                          disabled={busy}
                          onClick={() => onMove(variant)}
                          aria-label={`Переместить практику «${practice.title}»`}
                        >
                          Переместить
                        </button>
                      ) : null}
                      {onRemove ? (
                        <button
                          className="button button-quiet"
                          disabled={busy}
                          onClick={() => onRemove(variant)}
                          aria-label={`Исключить из семейства практику «${practice.title}»`}
                        >
                          Исключить
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </th>
                <td data-label="Получатели">
                  <ExpandableText text={practice.eligibility} />
                </td>
                <td data-label="Размер и условия">
                  <ExpandableText text={practice.amount} />
                  {practice.conditions?.length ? (
                    <div className="workshop-variant-conditions">
                      <ExpandableText text={practice.conditions.join('\n')} />
                    </div>
                  ) : null}
                </td>
                <td data-label="Основания">
                  <span>{variant.bundle.occurrences.length} документальных фрагментов</span>
                  {firstQuote ? (
                    <button
                      className="button button-quiet"
                      onClick={() => onOpenSource(firstQuote.anchor)}
                    >
                      Открыть цитату
                      <ArrowUpRight size={13} />
                    </button>
                  ) : null}
                  <small>Сопоставление полей доступно в подробной карточке.</small>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

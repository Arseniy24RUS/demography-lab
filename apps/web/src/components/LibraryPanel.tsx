import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronRight, CheckCircle2, FileText } from 'lucide-react';
import type { CorpusEntry, CorpusManifest } from '@/lib/corpus';
import { readable, safeExternalUrl } from '@/lib/corpus';

export function LibraryPanel({
  manifest,
  selected,
  onSelect,
  onDetails,
}: {
  manifest: CorpusManifest;
  selected: CorpusEntry;
  onSelect: (id: string) => void;
  onDetails: () => void;
}) {
  const [query, setQuery] = useState('');
  const [readyOnly, setReadyOnly] = useState(true);
  const items = useMemo(
    () =>
      manifest.documents
        .filter(
          (d) =>
            (!readyOnly || readable(d)) &&
            d.territory.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')),
        )
        .sort((a, b) => a.territory.localeCompare(b.territory, 'ru')),
    [manifest, query, readyOnly],
  );
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const container = listRef.current;
    const item = container?.querySelector<HTMLElement>('[aria-current="true"]');
    if (container && item) {
      container.scrollTop = item.offsetTop - container.offsetTop - 60;
    }
  }, [selected.id, items]);
  const readyCount = manifest.documents.filter(readable).length;
  return (
    <aside className="panel library-panel" aria-label="Библиотека программ">
      <h2 className="panel-heading">Библиотека программ</h2>
      <div className="library-search">
        <div className="search-field">
          <Search size={16} />
          <input
            className="input"
            aria-label="Найти программу"
            placeholder="Найти программу"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="library-filters">
        <button
          className={`filter-button ${readyOnly ? 'active' : ''}`}
          aria-pressed={readyOnly}
          onClick={() => setReadyOnly(true)}
        >
          С текстом · {readyCount}
        </button>
        <button
          className={`filter-button ${!readyOnly ? 'active' : ''}`}
          aria-pressed={!readyOnly}
          onClick={() => setReadyOnly(false)}
        >
          Все · {manifest.documents.length}
        </button>
      </div>
      <ul ref={listRef} className="region-list">
        {items.map((entry) => (
          <li key={entry.id}>
            <button
              className={`region-row ${entry.id === selected.id ? 'selected' : ''} ${!readable(entry) ? 'unavailable' : ''}`}
              aria-current={entry.id === selected.id ? 'true' : undefined}
              onClick={() => onSelect(entry.id)}
            >
              <span>
                {entry.territory}
                <small>
                  {readable(entry)
                    ? `${entry.pageCount} стр.${entry.quality === 'partial' ? ' · частичный материал' : ''}`
                    : 'Текст не подготовлен'}
                </small>
              </span>
              <ChevronRight size={14} />
            </button>
          </li>
        ))}
      </ul>
      {!items.length ? <p className="list-empty">Программы с таким названием не найдены.</p> : null}
      <div className="pagination-info">
        Показано {items.length} из {manifest.documents.length}
      </div>
      <dl className="source-summary">
        <div>
          <dt>Регион</dt>
          <dd>{selected.territory}</dd>
        </div>
        {selected.source.period?.label ? (
          <div>
            <dt>Период</dt>
            <dd>{selected.source.period.label}</dd>
          </div>
        ) : null}
        {selected.source.edition ? (
          <div>
            <dt>Редакция</dt>
            <dd>{selected.source.edition}</dd>
          </div>
        ) : null}
        <div>
          <dt>Текст</dt>
          <dd>
            <span
              className={`status ${readable(selected) ? (selected.status === 'review-required' ? 'warn' : 'good') : 'neutral'}`}
            >
              {readable(selected) ? <CheckCircle2 size={12} /> : <FileText size={12} />}{' '}
              {readable(selected)
                ? selected.status === 'review-required'
                  ? 'Нужна сверка'
                  : 'Подготовлен'
                : 'Нет материала'}
            </span>
          </dd>
        </div>
        <div>
          <dt>Источник</dt>
          <dd>
            {safeExternalUrl(selected.source.sourceUrl) ? (
              <a href={safeExternalUrl(selected.source.sourceUrl)} target="_blank" rel="noreferrer">
                Сохранённый документ
              </a>
            ) : (
              'Сведения в паспорте'
            )}
          </dd>
        </div>
      </dl>
      <div style={{ padding: '0 14px 16px' }}>
        <button className="button button-quiet small" onClick={onDetails}>
          <FileText size={14} />
          Паспорт и качество текста
        </button>
      </div>
    </aside>
  );
}

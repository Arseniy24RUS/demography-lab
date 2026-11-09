import { useEffect, useMemo, useState } from 'react';
import { Search, Link2, ArrowUpRight, Plus, Layers, Download } from 'lucide-react';
import type { PracticeFamily } from '@domain/index';
import type { CorpusManifest, RichVariant } from '@/lib/corpus';
import { isFamilyCatalogVariant } from '@/lib/family-catalog';
import { implementationLabel } from '@/lib/practice-status';

export function PracticeCatalogView({
  variants,
  families,
  manifest,
  onOpen,
  onCreate,
  catalogLoaded,
  catalogBusy,
  onLoadCatalog,
}: {
  variants: RichVariant[];
  families: PracticeFamily[];
  manifest: CorpusManifest;
  onOpen: (id: string) => void;
  onCreate: () => void;
  catalogLoaded: boolean;
  catalogBusy: boolean;
  onLoadCatalog: () => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [region, setRegion] = useState('');
  const [family, setFamily] = useState('');
  const [scope, setScope] = useState('all');
  const [page, setPage] = useState(1);
  const regionNames = useMemo(
    () =>
      new Map<string, string>([
        ...manifest.documents.map((d) => [d.regionId, d.territory] as const),
        ['federal', 'Федеральный уровень'],
        ['unknown', 'Территория не определена'],
      ]),
    [manifest],
  );
  const items = useMemo(
    () =>
      variants.filter(
        (v) =>
          (!region || v.regionId === region) &&
          (!family || v.familyId === family) &&
          (scope === 'all' ||
            (scope === 'catalog' ? isFamilyCatalogVariant(v) : !isFamilyCatalogVariant(v))) &&
          `${v.title} ${v.mechanism} ${v.eligibility ?? ''}`
            .toLocaleLowerCase('ru')
            .includes(query.toLocaleLowerCase('ru')),
      ),
    [variants, region, family, scope, query],
  );
  useEffect(() => setPage(1), [query, region, family, scope]);
  const maxPage = Math.max(1, Math.ceil(items.length / 48));
  const safePage = Math.min(page, maxPage);
  const visible = items.slice((safePage - 1) * 48, safePage * 48);
  const regionIds = [...new Set(variants.map((v) => v.regionId))].sort((a, b) =>
    (regionNames.get(a) ?? a).localeCompare(regionNames.get(b) ?? b, 'ru'),
  );
  return (
    <main id="main-content" className="content-page">
      <div className="catalog-intro">
        <div>
          <h2>Библиотека решений</h2>
          <p>
            {catalogLoaded
              ? 'Полный каталог загружен. Карточки каталога и варианты с подготовленными цитатами доступны для сопоставления.'
              : 'Сначала доступны варианты с подготовленными цитатами. Полный каталог мер загружается по запросу.'}
          </p>
        </div>
        {!catalogLoaded ? (
          <button
            className="button button-secondary"
            disabled={catalogBusy}
            onClick={() => void onLoadCatalog().catch(() => {})}
          >
            <Download size={16} />
            {catalogBusy ? 'Загрузка каталога…' : 'Загрузить полный каталог мер'}
          </button>
        ) : (
          <span className="status blue">
            {variants.filter(isFamilyCatalogVariant).length.toLocaleString('ru')} карточки каталога
          </span>
        )}
      </div>
      <div className="content-toolbar">
        <div className="search-field">
          <Search size={16} />
          <input
            className="input"
            aria-label="Поиск практик"
            placeholder="Название, механизм или получатели"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <select
          className="input"
          aria-label="Регион практики"
          value={region}
          onChange={(e) => setRegion(e.target.value)}
        >
          <option value="">Все регионы и уровни</option>
          {regionIds.map((r) => (
            <option key={r} value={r}>
              {regionNames.get(r) ?? r}
            </option>
          ))}
        </select>
        <select
          className="input"
          aria-label="Семейство практики"
          value={family}
          onChange={(e) => setFamily(e.target.value)}
        >
          <option value="">Все механизмы</option>
          {families.map((f) => (
            <option key={f.id} value={f.id}>
              {f.title}
            </option>
          ))}
        </select>
        {catalogLoaded ? (
          <select
            className="input"
            aria-label="Источник карточки"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="all">Все карточки</option>
            <option value="prepared">Подготовленные и авторские</option>
            <option value="catalog">Исходный каталог</option>
          </select>
        ) : null}
        <button className="button button-secondary" onClick={onCreate}>
          <Plus size={16} />
          Своя карточка
        </button>
      </div>
      <p className="step-explanation">
        Варианты одного механизма сохраняют региональные условия. Каждое поле проверяется отдельно.
        Наличие цитаты не означает, что мера действует на дату занятия или доказала
        результативность.
      </p>
      <p className="catalog-count" aria-live="polite">
        Найдено карточек: {items.length.toLocaleString('ru')}. Страница {safePage} из {maxPage}.
      </p>
      <div className="practice-grid">
        {visible.map((v) => (
          <article className="practice-tile" key={v.id}>
            <span className="status blue" style={{ alignSelf: 'flex-start' }}>
              <Layers size={12} />
              {families.find((f) => f.id === v.familyId)?.title ?? 'Авторское решение'}
            </span>
            <p className="tile-region">{regionNames.get(v.regionId) ?? v.regionId}</p>
            <h2>{v.title}</h2>
            {implementationLabel(v) ? (
              <p
                className={`implementation-status ${v.implementationStatus === 'described-existing' ? '' : 'proposed'}`}
              >
                {implementationLabel(v)}
              </p>
            ) : null}
            <p className="tile-summary">
              {v.mechanism.slice(0, 230)}
              {v.mechanism.length > 230 ? '…' : ''}
            </p>
            <div className="tile-footer">
              <span className="tile-evidence">
                <Link2 size={13} />
                {v.occurrenceIds.length} фрагм.
              </span>
              <button className="button button-quiet small" onClick={() => onOpen(v.id)}>
                Проверить <ArrowUpRight size={14} />
              </button>
            </div>
          </article>
        ))}
      </div>
      {!items.length ? (
        <div className="empty-state">
          <h3>Карточки не найдены</h3>
          <p>Измените поиск или создайте вариант по документу.</p>
        </div>
      ) : null}
      {maxPage > 1 ? (
        <nav className="catalog-pagination" aria-label="Страницы каталога">
          <button
            className="button button-secondary"
            disabled={safePage === 1}
            onClick={() => setPage(safePage - 1)}
          >
            Предыдущие
          </button>
          <span>
            {safePage} / {maxPage}
          </span>
          <button
            className="button button-secondary"
            disabled={safePage === maxPage}
            onClick={() => setPage(safePage + 1)}
          >
            Следующие
          </button>
        </nav>
      ) : null}
    </main>
  );
}

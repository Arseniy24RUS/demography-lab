import type { CatalogComparison } from '@/lib/corpus';
import { safeExternalUrl } from '@/lib/corpus';

export function CatalogComparisonView({ comparison }: { comparison: CatalogComparison }) {
  const c = comparison.catalogSnapshot;
  const href = safeExternalUrl(c.source_url);
  return (
    <details className="catalog-comparison">
      <summary>Сопоставление с каталогом мер</summary>
      <p className="comparison-note">{comparison.note.replace(/([а-яё])(?=\d)/gi, '$1 ')}</p>
      <p>
        <strong>В каталоге: </strong>
        {c.title}
      </p>
      {c.benefit ? (
        <p>
          <strong>Размер или форма: </strong>
          {c.benefit}
        </p>
      ) : null}
      {c.summary ? <p>{c.summary}</p> : null}
      <p className="muted">
        {c.fetched_at
          ? `Снимок каталога: ${new Date(c.fetched_at).toLocaleDateString('ru-RU')}. `
          : ''}
        Эта запись сохраняется отдельно от цитат программы и не подтверждает её положения.
      </p>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          Открыть запись каталога
        </a>
      ) : null}
    </details>
  );
}

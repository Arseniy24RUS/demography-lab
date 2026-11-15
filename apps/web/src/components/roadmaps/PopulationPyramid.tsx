import type { AgeSex } from '@/lib/roadmap-demography';

const integer = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
export const formatPeople = (value: number | null) => value === null ? '—' : integer.format(value);
export const ageLabel = (start: number, end: number | null) => end === null ? `${start}+` : `${start}–${end}`;

export function PopulationPyramid({ rows, label, maximum }: { rows: readonly AgeSex[]; label: string; maximum?: number }) {
  const scale = maximum ?? Math.max(1, ...rows.flatMap(row => [row[2] ?? 0, row[3] ?? 0]));
  return (
    <figure className="rm-pyramid" aria-label={label}>
      <figcaption className="rm-pyramid-row"><strong>Мужчины</strong><span>Возраст</span><strong>Женщины</strong></figcaption>
      {[...rows].reverse().map(([start, end, men, women]) => (
        <div className="rm-pyramid-row" key={start}>
          <span className="rm-pyramid-men">
            <span>{formatPeople(men)}</span>
            <i aria-hidden="true" style={{ width: `${(men ?? 0) / scale * 100}%` }} />
          </span>
          <span>{ageLabel(start, end)}</span>
          <span className="rm-pyramid-women">
            <i aria-hidden="true" style={{ width: `${(women ?? 0) / scale * 100}%` }} />
            <span>{formatPeople(women)}</span>
          </span>
        </div>
      ))}
    </figure>
  );
}

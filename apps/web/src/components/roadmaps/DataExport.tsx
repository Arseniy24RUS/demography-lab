import { useRef, useState, type RefObject } from 'react';
import { Download } from 'lucide-react';
import type { DataRows } from '../../../../../packages/export/data-sheet';
import type { ExportLegend } from '../../lib/roadmap-data-download';

export function DataExport({ title, rows, imageTarget, legend, pyramid }: {
  title: string;
  rows: DataRows;
  imageTarget?: RefObject<HTMLElement | null>;
  legend?: ExportLegend;
  pyramid?: { maximum?: number };
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!rows.length) return null;

  async function save(format: 'png' | 'xlsx') {
    setError(''); setBusy(true);
    try {
      const { createDataPng, downloadData } = await import('../../lib/roadmap-data-download');
      if (format === 'xlsx') {
        const { exportDataSheet } = await import('../../../../../packages/export/data-sheet');
        const source = exportDataSheet(rows, title);
        downloadData(new Blob([new Uint8Array(source).buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), title, format);
      } else {
        const svg = imageTarget?.current?.querySelector<SVGSVGElement>('svg[role="img"], svg[data-data-export]');
        if (imageTarget && !svg) throw new Error('Откройте график перед сохранением изображения.');
        downloadData(await createDataPng({ title, rows, svg: svg ?? undefined, legend, pyramid }), title, format);
      }
      if (menu.current) {
        menu.current.open = false;
        menu.current.querySelector('summary')?.focus();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось скачать данные.');
    } finally { setBusy(false); }
  }

  return <details ref={menu} className="rm-data-download" onKeyDown={event => {
    if (event.key === 'Escape' && menu.current?.open) {
      menu.current.open = false;
      menu.current.querySelector('summary')?.focus();
    }
  }} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && !busy) event.currentTarget.open = false; }}>
    <summary aria-label={`Скачать: ${title}`} title="Скачать данные или изображение"><Download size={17} aria-hidden="true" /></summary>
    <div className="rm-data-download-menu" aria-busy={busy}>
      <button type="button" disabled={busy} onClick={() => void save('xlsx')}>Данные XLSX</button>
      <button type="button" disabled={busy} onClick={() => void save('png')}>Изображение PNG</button>
      {error ? <small role="alert">{error}</small> : null}
    </div>
  </details>;
}

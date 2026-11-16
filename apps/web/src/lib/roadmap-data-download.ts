import type { DataRows } from '../../../../packages/export/data-sheet';

export type ExportLegend = readonly { label: string; color: string; dashed?: boolean }[];
type PngData = { title: string; rows: DataRows; svg?: SVGSVGElement; legend?: ExportLegend; pyramid?: { maximum?: number } };
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6 });
const label = (cell: string | number | null | undefined) => typeof cell === 'number' ? number.format(cell) : cell ?? '—';
const ink = '#193651';
const pad = 26;

function canvasFor(width: number, height: number) {
  const canvas = document.createElement('canvas');
  const scale = Math.min(2, 8192 / Math.max(width, height), Math.sqrt(20_000_000 / (width * height)));
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Браузер не может подготовить изображение.');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = ink;
  ctx.textBaseline = 'middle';
  return { canvas, ctx };
}

function titleLine(ctx: CanvasRenderingContext2D, title: string, width: number) {
  ctx.fillStyle = ink;
  ctx.font = '600 21px system-ui, sans-serif';
  ctx.fillText(title, pad, 36, width - 2 * pad);
}

const copiedStyles = ['fill', 'fill-opacity', 'stroke', 'stroke-opacity', 'stroke-width', 'stroke-dasharray',
  'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'font-family', 'font-weight', 'font-size',
  'letter-spacing', 'text-anchor', 'dominant-baseline', 'visibility', 'vector-effect'] as const;
async function exportedSvg(svg: SVGSVGElement) {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const from = [svg, ...svg.querySelectorAll<SVGElement>('*')];
  const to = [clone, ...clone.querySelectorAll<SVGElement>('*')];
  for (let i = 0; i < to.length; i++) {
    const computed = getComputedStyle(from[i]!);
    for (const style of copiedStyles) {
      const value = computed.getPropertyValue(style);
      if (value) to[i]!.style.setProperty(style, style === 'font-family' ? 'system-ui, sans-serif' : value);
    }
  }
  const box = svg.viewBox.baseVal;
  const width = box.width || svg.clientWidth;
  const height = box.height || svg.clientHeight;
  if (!(width > 0 && height > 0)) throw new Error('Откройте график перед сохранением изображения.');
  clone.setAttribute('width', String(width)); clone.setAttribute('height', String(height));
  // XMLSerializer emits the root SVG namespace for a real SVG element.
  clone.querySelectorAll('[data-export-skip]').forEach(node => node.remove());
  const src = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    image.src = src;
    await image.decode();
    return { image, width, height };
  } finally { URL.revokeObjectURL(src); }
}

async function svgPng({ title, svg, legend }: PngData & { svg: SVGSVGElement }) {
  const img = await exportedSvg(svg);
  const bodyWidth = Math.min(1130, Math.max(480, img.width));
  const bodyHeight = img.height * bodyWidth / img.width;
  const width = bodyWidth + pad * 2;
  const leg = legend ?? [];
  const height = bodyHeight + 66 + (leg.length ? 20 * leg.length + 15 : pad);
  const { canvas, ctx } = canvasFor(width, height);
  titleLine(ctx, title, width);
  ctx.drawImage(img.image, pad, 60, bodyWidth, bodyHeight);
  ctx.font = '14px system-ui, sans-serif';
  leg.forEach((line, i) => {
    const y = bodyHeight + 71 + 20 * i;
    ctx.beginPath(); ctx.strokeStyle = line.color; ctx.lineWidth = 3;
    ctx.setLineDash(line.dashed ? [5, 4] : []); ctx.moveTo(pad, y); ctx.lineTo(pad + 25, y); ctx.stroke();
    ctx.fillText(line.label, pad + 34, y, bodyWidth - 36);
  });
  return canvas;
}

function pyramidPng({ title, rows, pyramid }: PngData) {
  const data = rows.slice(1);
  const max = Math.max(1, pyramid?.maximum ?? 0, ...data.flatMap(row => row.slice(1).map(cell => typeof cell === 'number' ? cell : 0)));
  const width = 760, line = 27, top = 104, height = top + data.length * line + pad;
  const { canvas, ctx } = canvasFor(width, height);
  titleLine(ctx, title, width);
  const center = width / 2, gap = 37, area = center - gap - pad - 55;
  ctx.textAlign = 'center'; ctx.font = '600 14px system-ui, sans-serif';
  ctx.fillText(label(rows[0]?.[1]), (center - gap + pad) / 2, 76);
  ctx.fillText(label(rows[0]?.[2]), width - (center - gap + pad) / 2, 76);
  ctx.font = '13px system-ui, sans-serif';
  data.forEach(([age, male, female], i) => {
    const y = top + i * line;
    const m = typeof male === 'number' ? male / max * area : 0;
    const f = typeof female === 'number' ? female / max * area : 0;
    ctx.fillStyle = '#407db8'; ctx.fillRect(center - gap - m, y - 8, m, 16);
    ctx.fillStyle = '#21877f'; ctx.fillRect(center + gap, y - 8, f, 16);
    ctx.fillStyle = ink; ctx.textAlign = 'center'; ctx.fillText(label(age), center, y);
    ctx.textAlign = 'right'; ctx.fillText(label(male), center - gap - m - 5, y, 78);
    ctx.textAlign = 'left'; ctx.fillText(label(female), center + gap + f + 5, y, 78);
  });
  return canvas;
}

function tablePng({ title, rows }: PngData) {
  const columns = Math.max(...rows.map(row => row.length));
  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) throw new Error('Браузер не может подготовить таблицу.');
  measure.font = '14px system-ui, sans-serif';
  const widths = Array.from({ length: columns }, (_, i) => Math.ceil(Math.min(480,
    Math.max(110, ...rows.map(row => measure.measureText(label(row[i])).width + 30)))));
  const width = widths.reduce((a, b) => a + b, pad * 2);
  function wrap(text: string, maxWidth: number) {
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(/\s+/u)) {
      if (line && measure!.measureText(`${line} ${word}`).width > maxWidth) { lines.push(line); line = ''; }
      line = line ? `${line} ${word}` : word;
    }
    return [...lines, line];
  }
  const prepared = rows.map(row => widths.map((w, i) => wrap(label(row[i]), w - 24)));
  const heights = prepared.map(row => Math.max(...row.map(cell => cell.length)) * 20 + 15);
  const height = heights.reduce((sum, size) => sum + size, 65 + pad);
  const { canvas, ctx } = canvasFor(width, height);
  titleLine(ctx, title, width);
  let y = 64;
  for (let i = 0; i < prepared.length; i++) {
    const rowHeight = heights[i]!;
    ctx.fillStyle = i === 0 ? '#e7eff8' : i % 2 === 0 ? '#f6f9fc' : '#fff';
    ctx.fillRect(pad, y, width - pad * 2, rowHeight);
    ctx.strokeStyle = '#d9e2ec';
    ctx.strokeRect(pad, y, width - pad * 2, rowHeight);
    ctx.fillStyle = ink;
    ctx.font = `${i === 0 ? '600' : '400'} 14px system-ui, sans-serif`;
    let x = pad;
    for (let j = 0; j < columns; j++) {
      const w = widths[j]!;
      const numeric = typeof rows[i]?.[j] === 'number';
      ctx.textAlign = numeric ? 'right' : 'left';
      prepared[i]![j]!.forEach((text, k) => ctx.fillText(text, numeric ? x + w - 12 : x + 12, y + 18 + 20 * k, w - 24));
      x += w;
    }
    y += rowHeight;
  }
  return canvas;
}

export async function createDataPng(input: PngData): Promise<Blob> {
  const canvas = input.svg ? await svgPng({ ...input, svg: input.svg }) : input.pyramid ? pyramidPng(input) : tablePng(input);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Не удалось сформировать PNG.')), 'image/png'));
}

export function downloadData(blob: Blob, title: string, extension: string) {
  const url = URL.createObjectURL(blob);
  const download = document.createElement('a');
  download.href = url;
  download.download = `${title.replace(/[<>:"/\\|?*]/gu, ' ').trim().slice(0, 120).replace(/[.\s]+$/u, '') || 'Данные'}.${extension}`;
  document.body.append(download); download.click(); download.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

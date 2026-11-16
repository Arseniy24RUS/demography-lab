import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage, RGB } from 'pdf-lib';
import { points, roadmapLayout } from './layout';
import type { PdfExportFonts, PreparedRoadmapExport, ReportBlock, RoadmapFigure } from './types';

const PAGE_WIDTH = points(roadmapLayout.page.width);
const PAGE_HEIGHT = points(roadmapLayout.page.height);
const LEFT = points(roadmapLayout.margin.left);
const TOP = points(roadmapLayout.margin.top);
const BOTTOM = points(roadmapLayout.margin.bottom);
const CONTENT_WIDTH = PAGE_WIDTH - LEFT - points(roadmapLayout.margin.right);
const FIRST_LINE_INDENT = points(roadmapLayout.firstLineIndent);

function color(hex: string): RGB {
  const raw = hex.replace('#', '');
  return rgb(
    parseInt(raw.slice(0, 2), 16) / 255,
    parseInt(raw.slice(2, 4), 16) / 255,
    parseInt(raw.slice(4, 6), 16) / 255,
  );
}
const black = rgb(0, 0, 0);
const lineColor = color('#A0A0A0');

function wrapLine(text: string, font: PDFFont, size: number, width: number, indent = 0): string[] {
  if (width <= size) throw new Error('Недопустимая ширина колонки PDF.');
  const lines: string[] = [];
  const limit = () => width - (lines.length === 0 ? indent : 0);
  const fits = (part: string) => font.widthOfTextAtSize(part, size) <= limit();
  let current = '';
  for (const word of text.match(/[^\t ]+/gu) ?? []) {
    const next = current ? `${current} ${word}` : word;
    if (fits(next)) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = '';
    if (fits(word)) {
      current = word;
      continue;
    }
    // A single very long word or URL also has to fit its column.
    for (const character of word) {
      if (current && !fits(current + character)) {
        lines.push(current);
        current = '';
      }
      current += character;
    }
  }
  if (current || !lines.length) lines.push(current);
  return lines;
}

const paragraphs = (text: string) => text.split(/\r\n?|\n/u);

class PdfWriter {
  page!: PDFPage;
  y = PAGE_HEIGHT - TOP;
  constructor(
    readonly document: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
  ) {
    this.newPage();
  }

  newPage(): void {
    if (this.document.getPageCount() >= 2000)
      throw new Error(
        'Объём PDF превысил 2000 страниц. Сохраните JSON и сократите документальные приложения.',
      );
    this.page = this.document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - TOP;
    const pageNumber = this.document.getPageCount();
    if (pageNumber > 1) {
      const text = String(pageNumber);
      const size = roadmapLayout.bodySize;
      this.page.drawText(text, {
        x: (PAGE_WIDTH - this.regular.widthOfTextAtSize(text, size)) / 2,
        y: PAGE_HEIGHT - points(roadmapLayout.margin.header) - size,
        size,
        font: this.regular,
      });
    }
  }
  ensure(height: number): void {
    if (this.y - height < BOTTOM) this.newPage();
  }
  paragraph(
    text: string,
    options: {
      size?: number;
      bold?: boolean;
      before?: number;
      after?: number;
      indent?: number;
      alignment?: 'left' | 'center' | 'justify';
      keepLines?: boolean;
      keepSpace?: number;
    } = {},
  ): void {
    const size = options.size ?? roadmapLayout.bodySize;
    const font = options.bold ? this.bold : this.regular;
    const lineHeight = size * roadmapLayout.lineSpacing;
    const indent = options.indent ?? 0;
    const before = options.before ?? 0;
    const after = options.after ?? 0;
    const keepSpace = options.keepSpace ?? 0;
    const groups = paragraphs(text).map((line) => wrapLine(line, font, size, CONTENT_WIDTH, indent));
    const firstGroup = groups[0]!;
    const firstLines = options.keepLines ? firstGroup.length : Math.min(2, firstGroup.length);
    this.ensure(before + lineHeight * firstLines + after + keepSpace);
    this.y -= before;
    for (const [groupIndex, lines] of groups.entries()) {
      this.ensure(lineHeight * Math.min(2, lines.length));
      for (const [index, line] of lines.entries()) {
        const remaining = lines.length - index;
        const keep = remaining === 1 && groupIndex === groups.length - 1 ? keepSpace + after : 0;
        this.ensure(lineHeight * (remaining === 2 ? 2 : 1) + keep);
        const start = index === 0 ? indent : 0;
        const width = CONTENT_WIDTH - start;
        const textWidth = font.widthOfTextAtSize(line, size);
        const x = LEFT + start + (options.alignment === 'center' ? (width - textWidth) / 2 : 0);
        const y = this.y - size;
        if (options.alignment === 'justify' && remaining > 1 && line.includes(' ')) {
          // Type 0 fonts do not expand two-byte space CIDs via PDF's word-spacing operator.
          const words = line.split(' ');
          const runs = words.map((word, index) => (index < words.length - 1 ? `${word} ` : word));
          const advances = runs.map((run) => font.widthOfTextAtSize(run, size));
          const extra = Math.max(0, (width - advances.reduce((sum, n) => sum + n, 0)) / (words.length - 1));
          let wordX = x;
          for (const [index, run] of runs.entries()) {
            this.page.drawText(run, { x: wordX, y, size, font, color: black });
            wordX += advances[index]! + extra;
          }
        } else if (line) {
          this.page.drawText(line, { x, y, size, font, color: black });
        }
        this.y -= lineHeight;
      }
    }
    this.y -= after;
  }
  heading(text: string, level: number): void {
    this.paragraph(text, {
      alignment: level === 1 ? 'center' : 'left',
      indent: level === 1 ? 0 : FIRST_LINE_INDENT,
      bold: true,
      before: level === 1 ? 12 : 8,
      after: 4,
      keepLines: true,
      keepSpace: roadmapLayout.bodySize * roadmapLayout.lineSpacing,
    });
  }
  table(block: Extract<ReportBlock, { kind: 'table' }>, number: number): void {
    const weights = block.columns.reduce((sum, column) => sum + column.weight, 0);
    const widths = block.columns.map((column) => (column.weight / weights) * CONTENT_WIDTH);
    const size = roadmapLayout.tableSize;
    const lineHeight = size * 1.18;
    const padding = 4;
    const wrapCell = (text: string, font: PDFFont, column: number) =>
      paragraphs(text).flatMap((line) => wrapLine(line, font, size, widths[column]! - padding * 2));
    const header = block.columns.map((column, i) => wrapCell(column.title, this.bold, i));
    const headerHeight = Math.max(...header.map((cell) => cell.length)) * lineHeight + padding * 2;
    this.paragraph(`Таблица ${number} — ${block.caption}`, {
      before: 7,
      after: 6,
      keepLines: true,
      keepSpace: headerHeight + lineHeight + padding * 2,
    });
    const drawRow = (
      cells: string[][],
      from: number,
      count: number,
      isHeader: boolean,
    ) => {
      const height = count * lineHeight + padding * 2;
      let x = LEFT;
      for (let column = 0; column < widths.length; column++) {
        const width = widths[column]!;
        this.page.drawRectangle({
          x,
          y: this.y - height,
          width,
          height,
          color: isHeader ? color('#F3F3F3') : rgb(1, 1, 1),
          borderColor: lineColor,
          borderWidth: 0.45,
        });
        const font = isHeader ? this.bold : this.regular;
        const align = isHeader ? 'left' : (block.columns[column]!.align ?? 'left');
        const lines = cells[column]!.slice(from, from + count);
        // Centre shorter cell content vertically in the row segment.
        const offset = Math.max(0, ((count - lines.length) * lineHeight) / 2);
        lines.forEach((line, rowIndex) => {
          const textWidth = font.widthOfTextAtSize(line, size);
          const textX =
            align === 'right'
              ? x + width - padding - textWidth
              : align === 'center'
                ? x + (width - textWidth) / 2
                : x + padding;
          this.page.drawText(line, {
            x: textX,
            y: this.y - padding - size - rowIndex * lineHeight - offset,
            size,
            font,
            color: black,
          });
        });
        x += width;
      }
      this.y -= height;
    };
    const repeatHeader = () =>
      drawRow(header, 0, Math.max(...header.map((cell) => cell.length)), true);
    repeatHeader();
    for (const values of block.rows) {
      const cells = values.map((value, i) => wrapCell(value, this.regular, i));
      const count = Math.max(...cells.map((cell) => cell.length));
      const fullHeight = count * lineHeight + padding * 2;
      const maxBodyHeight = PAGE_HEIGHT - TOP - BOTTOM - headerHeight;
      if (fullHeight > this.y - BOTTOM && fullHeight <= maxBodyHeight) {
        this.newPage();
        repeatHeader();
      }
      let cursor = 0;
      while (cursor < count) {
        let available = Math.floor((this.y - BOTTOM - padding * 2) / lineHeight);
        if (available < 1) {
          this.newPage();
          repeatHeader();
          available = Math.floor((this.y - BOTTOM - padding * 2) / lineHeight);
        }
        const chunk = Math.min(available, count - cursor);
        drawRow(cells, cursor, chunk, false);
        cursor += chunk;
        if (cursor < count) {
          this.newPage();
          repeatHeader();
        }
      }
    }
    this.y -= 9;
  }
  figure(figure: RoadmapFigure, number: number): void {
    const caption = `Рисунок ${number} — ${figure.title}`;
    const captionHeight =
      wrapLine(caption, this.regular, roadmapLayout.bodySize, CONTENT_WIDTH).length *
      roadmapLayout.bodySize * roadmapLayout.lineSpacing;
    const figureSpacing = 14;
    const scale = Math.min(
      CONTENT_WIDTH / figure.width,
      (PAGE_HEIGHT - TOP - BOTTOM - captionHeight - figureSpacing) / figure.height,
    );
    const height = figure.height * scale;
    this.ensure(height + captionHeight + figureSpacing);
    const figureTop = this.y - 7;
    const figureLeft = LEFT + (CONTENT_WIDTH - figure.width * scale) / 2;
    const xx = (x: number) => figureLeft + x * scale;
    const yy = (y: number) => figureTop - y * scale;
    for (const primitive of figure.primitives) {
      if (primitive.kind === 'line')
        this.page.drawLine({
          start: { x: xx(primitive.x1), y: yy(primitive.y1) },
          end: { x: xx(primitive.x2), y: yy(primitive.y2) },
          thickness: primitive.width * scale,
          color: color(primitive.color),
          dashArray: primitive.dash?.map((n) => n * scale),
          dashPhase: primitive.dashPhase === undefined ? undefined : primitive.dashPhase * scale,
        });
      else if (primitive.kind === 'rect')
        this.page.drawRectangle({
          x: xx(primitive.x),
          y: yy(primitive.y + primitive.height),
          width: primitive.width * scale,
          height: primitive.height * scale,
          color: color(primitive.fill),
          borderColor: primitive.stroke ? color(primitive.stroke) : undefined,
          borderWidth: primitive.stroke ? 0.5 : 0,
        });
      else if (primitive.kind === 'circle')
        this.page.drawCircle({
          x: xx(primitive.x),
          y: yy(primitive.y),
          size: primitive.radius * scale,
          color: color(primitive.fill),
        });
      else {
        const font = primitive.bold ? this.bold : this.regular;
        const size = primitive.size * scale;
        const textWidth = font.widthOfTextAtSize(primitive.text, size);
        const x =
          xx(primitive.x) -
          (primitive.align === 'middle'
            ? textWidth / 2
            : primitive.align === 'end'
              ? textWidth
              : 0);
        this.page.drawText(primitive.text, {
          x,
          y: yy(primitive.y),
          size,
          font,
          color: color(primitive.color),
        });
      }
    }
    this.y = figureTop - height;
    this.paragraph(caption, { alignment: 'center', after: 7, keepLines: true });
  }
}

function checkFontCoverage(prepared: PreparedRoadmapExport, regular: PDFFont, bold: PDFFont): void {
  const regularCodes = new Set(regular.getCharacterSet());
  const boldCodes = new Set(bold.getCharacterSet());
  const strings = [
    prepared.title,
    prepared.subtitle,
    ...prepared.blocks.flatMap((block) =>
      block.kind === 'heading'
        ? [block.text]
        : block.kind === 'paragraph'
          ? [block.label ?? '', block.text]
          : block.kind === 'table'
            ? [block.caption, ...block.columns.map((c) => c.title), ...block.rows.flat()]
            : [
                block.figure.title,
                ...block.figure.primitives.flatMap((p) => (p.kind === 'text' ? [p.text] : [])),
              ],
    ),
  ];
  const missing = new Set<number>();
  for (const text of strings)
    for (const character of text) {
      const code = character.codePointAt(0)!;
      if (code === 9 || code === 10 || code === 13) continue;
      if (!regularCodes.has(code) || !boldCodes.has(code)) missing.add(code);
    }
  if (missing.size)
    throw new Error(
      `Встроенный шрифт PDF не содержит символы ${[...missing]
        .slice(0, 8)
        .map((code) => `U+${code.toString(16).toUpperCase()}`)
        .join(
          ', ',
        )}. Текст не заменён: сохраните DOCX или JSON либо используйте поддерживаемые символы.`,
    );
}

export async function buildRoadmapPdf(
  prepared: PreparedRoadmapExport,
  fonts: PdfExportFonts,
): Promise<Uint8Array> {
  if (!fonts.license.trim())
    throw new Error('Для встраивания шрифтов PDF требуется текст лицензии.');
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const regular = await document.embedFont(fonts.regular, { subset: true });
  const bold = await document.embedFont(fonts.bold, { subset: true });
  checkFontCoverage(prepared, regular, bold);
  document.setTitle([prepared.title, prepared.subtitle].filter(Boolean).join(' — '));
  document.setAuthor('Демографическая мастерская');
  document.setSubject('Дорожная карта демографического проекта');
  document.setCreator('Демографическая мастерская');
  document.setProducer('Демографическая мастерская');
  document.setLanguage('ru-RU');
  const createdAt = new Date(prepared.version.createdAt);
  document.setCreationDate(createdAt);
  document.setModificationDate(createdAt);
  const writer = new PdfWriter(document, regular, bold);
  writer.paragraph(prepared.title, { alignment: 'center', bold: true, after: 6, keepLines: true });
  if (prepared.subtitle)
    writer.paragraph(prepared.subtitle, { alignment: 'center', after: 6, keepLines: true });
  let tableNumber = 0;
  let figureNumber = 0;
  for (const block of prepared.blocks) {
    if (block.kind === 'heading') writer.heading(block.text, block.level);
    else if (block.kind === 'paragraph')
      writer.paragraph(`${block.label ? `${block.label}. ` : ''}${block.text}`, {
        alignment: block.role === 'meta' ? 'center' : 'justify',
        indent: block.role === 'meta' ? 0 : FIRST_LINE_INDENT,
      });
    else if (block.kind === 'table') writer.table(block, ++tableNumber);
    else writer.figure(block.figure, ++figureNumber);
  }
  return document.save({ useObjectStreams: true, addDefaultPage: false });
}

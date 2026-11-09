import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage, RGB } from 'pdf-lib';
import type { PdfExportFonts, PreparedRoadmapExport, ReportBlock, RoadmapFigure } from './types';

// Same A4 page as the supplied Word template, converted from twips to PDF points.
const PAGE_WIDTH = 11906 / 20;
const PAGE_HEIGHT = 16838 / 20;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BOTTOM = 54;

function color(hex: string): RGB {
  const raw = hex.replace('#', '');
  return rgb(
    parseInt(raw.slice(0, 2), 16) / 255,
    parseInt(raw.slice(2, 4), 16) / 255,
    parseInt(raw.slice(4, 6), 16) / 255,
  );
}
const ink = color('#17222F');
const black = rgb(0, 0, 0);
const muted = color('#4F5D6B');
const lineColor = color('#D9D9D9');

/** Wrap long identifiers as well as prose, preserving each non-whitespace code point. */
function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  if (width <= size) throw new Error('Недопустимая ширина колонки PDF.');
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/gu, '\n').replace(/\t/gu, '    ').split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    const words = paragraph.split(/(?<=\s)|(?=\s)/u);
    let current = '';
    for (let word of words) {
      if (!current && /^\s+$/u.test(word)) continue;
      if (font.widthOfTextAtSize(current + word, size) <= width) {
        current += word;
        continue;
      }
      if (current.trim()) {
        lines.push(current.trimEnd());
        current = '';
      }
      if (/^\s+$/u.test(word)) continue;
      if (font.widthOfTextAtSize(word, size) <= width) {
        current = word;
        continue;
      }
      let part = '';
      for (const character of [...word]) {
        if (part && font.widthOfTextAtSize(part + character, size) > width) {
          lines.push(part);
          part = '';
        }
        part += character;
      }
      current = part;
    }
    if (current || !lines.length) lines.push(current.trimEnd());
  }
  return lines;
}

class PdfWriter {
  page!: PDFPage;
  y = PAGE_HEIGHT - MARGIN;
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
    this.y = PAGE_HEIGHT - MARGIN;
  }
  ensure(height: number): void {
    if (this.y - height < BOTTOM) this.newPage();
  }
  paragraph(
    text: string,
    options: {
      size?: number;
      bold?: boolean;
      muted?: boolean;
      before?: number;
      after?: number;
      indent?: number;
      keepSpace?: number;
    } = {},
  ): void {
    const size = options.size ?? 10.7;
    const font = options.bold ? this.bold : this.regular;
    const lineHeight = size * 1.35;
    const indent = options.indent ?? 0;
    const lines = wrapText(text, font, size, CONTENT_WIDTH - indent * 2);
    const before = options.before ?? 0;
    this.ensure(before + lineHeight * Math.min(2, lines.length) + (options.keepSpace ?? 0));
    this.y -= before;
    for (const [index, line] of lines.entries()) {
      const keep = index === lines.length - 1 ? (options.keepSpace ?? 0) : 0;
      this.ensure(lineHeight + keep);
      this.page.drawText(line, {
        x: MARGIN + indent,
        y: this.y - size,
        size,
        font,
        color: options.muted ? muted : ink,
      });
      this.y -= lineHeight;
    }
    this.y -= options.after ?? 6;
  }
  heading(text: string, level: number): void {
    const size = level === 1 ? 14.3 : level === 2 ? 12.1 : 11.3;
    const before = level === 1 ? 15 : 10;
    const lines = wrapText(text, this.bold, size, CONTENT_WIDTH);
    this.ensure(before + lines.length * size * 1.28 + 35);
    this.y -= before;
    for (const line of lines) {
      this.page.drawText(line, {
        x: MARGIN,
        y: this.y - size,
        size,
        font: this.bold,
        color: black,
      });
      this.y -= size * 1.28;
    }
    this.y -= 8;
  }
  table(block: Extract<ReportBlock, { kind: 'table' }>): void {
    const weights = block.columns.reduce((sum, column) => sum + column.weight, 0);
    const widths = block.columns.map((column) => (column.weight / weights) * CONTENT_WIDTH);
    const size = 9.1;
    const lineHeight = 12.4;
    const padding = 6;
    const header = block.columns.map((column, i) =>
      wrapText(column.title, this.bold, size, widths[i]! - padding * 2),
    );
    const headerHeight = Math.max(...header.map((cell) => cell.length)) * lineHeight + padding * 2;
    this.paragraph(block.caption, {
      bold: true,
      before: 7,
      after: 6,
      keepSpace: headerHeight + lineHeight + padding * 2,
    });
    const drawRow = (
      cells: string[][],
      from: number,
      count: number,
      isHeader: boolean,
      index: number,
    ) => {
      const height = count * lineHeight + padding * 2;
      let x = MARGIN;
      for (let column = 0; column < widths.length; column++) {
        const width = widths[column]!;
        this.page.drawRectangle({
          x,
          y: this.y - height,
          width,
          height,
          color: isHeader ? color('#2D435D') : index % 2 === 0 ? color('#F4F6F8') : rgb(1, 1, 1),
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
            color: isHeader ? rgb(1, 1, 1) : ink,
          });
        });
        x += width;
      }
      this.y -= height;
    };
    const repeatHeader = () =>
      drawRow(header, 0, Math.max(...header.map((cell) => cell.length)), true, 0);
    repeatHeader();
    for (const [rowIndex, values] of block.rows.entries()) {
      const cells = values.map((value, i) =>
        wrapText(value, this.regular, size, widths[i]! - padding * 2),
      );
      const count = Math.max(...cells.map((cell) => cell.length));
      const fullHeight = count * lineHeight + padding * 2;
      const maxBodyHeight = PAGE_HEIGHT - MARGIN - BOTTOM - headerHeight;
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
        drawRow(cells, cursor, chunk, false, rowIndex);
        cursor += chunk;
        if (cursor < count) {
          this.newPage();
          repeatHeader();
        }
      }
    }
    this.y -= 9;
  }
  figure(figure: RoadmapFigure): void {
    const scale = CONTENT_WIDTH / figure.width;
    const height = figure.height * scale;
    this.paragraph(figure.title, { bold: true, before: 7, after: 6, keepSpace: height });
    this.ensure(height);
    const figureTop = this.y;
    const xx = (x: number) => MARGIN + x * scale;
    const yy = (y: number) => figureTop - y * scale;
    for (const primitive of figure.primitives) {
      if (primitive.kind === 'line')
        this.page.drawLine({
          start: { x: xx(primitive.x1), y: yy(primitive.y1) },
          end: { x: xx(primitive.x2), y: yy(primitive.y2) },
          thickness: primitive.width * scale,
          color: color(primitive.color),
          dashArray: primitive.dash?.map((n) => n * scale),
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
    this.y -= height + 4;
    this.paragraph(figure.altText, { size: 9.4, muted: true, after: 8 });
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
                block.figure.altText,
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
  document.setTitle(`${prepared.title} ${prepared.subtitle}`);
  document.setAuthor('Демографическая мастерская');
  document.setSubject(`Версия ${prepared.version.number}; SHA-256 ${prepared.version.sha256}`);
  document.setKeywords([
    'Демографическая мастерская',
    prepared.version.sha256,
    prepared.exportVersion,
  ]);
  document.setCreator('Демографическая мастерская');
  document.setProducer('Демографическая мастерская / pdf-lib');
  document.setLanguage('ru-RU');
  const createdAt = new Date(prepared.version.createdAt);
  document.setCreationDate(createdAt);
  document.setModificationDate(createdAt);
  const writer = new PdfWriter(document, regular, bold);
  writer.paragraph(prepared.title, { size: 20, bold: true, after: 10, keepSpace: 60 });
  writer.paragraph(prepared.subtitle, { size: 14, after: 18, keepSpace: 35 });
  for (const block of prepared.blocks) {
    if (block.kind === 'heading') writer.heading(block.text, block.level);
    else if (block.kind === 'paragraph')
      writer.paragraph(`${block.label ? `${block.label}. ` : ''}${block.text}`, {
        size: block.role === 'meta' ? 9.6 : 10.7,
        muted: block.role === 'meta',
        indent: block.role === 'quote' ? 12 : 0,
      });
    else if (block.kind === 'table') writer.table(block);
    else writer.figure(block.figure);
  }
  const pages = document.getPages();
  pages.forEach((page, index) => {
    const text = `Версия ${prepared.version.number} · ${prepared.version.sha256.slice(0, 12)} · ${index + 1} / ${pages.length}`;
    page.drawText(text, {
      x: PAGE_WIDTH - MARGIN - regular.widthOfTextAtSize(text, 8),
      y: 31,
      size: 8,
      font: regular,
      color: muted,
    });
  });
  await document.attach(
    new TextEncoder().encode(prepared.version.canonicalJson),
    'canonical.json',
    {
      mimeType: 'application/json',
      description: `SHA-256 ${prepared.version.sha256}`,
      creationDate: createdAt,
      modificationDate: createdAt,
    },
  );
  await document.attach(new TextEncoder().encode(fonts.license), 'FONT-LICENSE.txt', {
    mimeType: 'text/plain',
    description: 'DejaVu Sans font license',
    creationDate: createdAt,
    modificationDate: createdAt,
  });
  return document.save({ useObjectStreams: true, addDefaultPage: false });
}

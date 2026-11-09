import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  PageNumber,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';
import type { FileChild } from 'docx';
import { figureSvg } from './figures';
import type { DocxExportOptions, PreparedRoadmapExport, ReportBlock } from './types';

// Preserve the A4 sheet in Roadmap_Template_Original.docx (11906 × 16838 twips).
const pageWidth = 11906;
const contentWidth = 9746;
const border = { style: BorderStyle.SINGLE, size: 4, color: 'D9D9D9' };
const borders = {
  top: border,
  bottom: border,
  left: border,
  right: border,
  insideHorizontal: border,
  insideVertical: border,
};

function textParagraph(
  text: string,
  options: {
    bold?: boolean;
    color?: string;
    size?: number;
    label?: string;
    quote?: boolean;
    after?: number;
  } = {},
): Paragraph {
  const children: TextRun[] = [];
  if (options.label)
    children.push(
      new TextRun({
        text: `${options.label}. `,
        bold: true,
        size: options.size ?? 22,
        color: options.color ?? '000000',
      }),
    );
  const lines = text.split('\n');
  lines.forEach((line, index) =>
    children.push(
      new TextRun({
        text: line,
        break: index > 0 ? 1 : undefined,
        bold: options.bold,
        italics: options.quote,
        color: options.color ?? '000000',
        size: options.size ?? 22,
      }),
    ),
  );
  return new Paragraph({
    children,
    spacing: { after: options.after ?? 120, line: 282 },
    indent: options.quote ? { left: 280, right: 160 } : undefined,
    widowControl: true,
  });
}
function reportTable(block: Extract<ReportBlock, { kind: 'table' }>): FileChild[] {
  const totalWeight = block.columns.reduce((sum, column) => sum + column.weight, 0);
  const widths = block.columns.map((column) =>
    Math.round((contentWidth * column.weight) / totalWeight),
  );
  widths[widths.length - 1]! += contentWidth - widths.reduce((a, b) => a + b, 0);
  const row = (values: string[], isHeader: boolean, index: number) =>
    new TableRow({
      tableHeader: isHeader,
      // Keep ordinary records together; very long source or stage rows may flow.
      cantSplit: isHeader || values.reduce((count, value) => count + value.length, 0) < 1200,
      children: values.map(
        (text, columnIndex) =>
          new TableCell({
            width: { size: widths[columnIndex]!, type: WidthType.DXA },
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 100, bottom: 100, left: 110, right: 110 },
            shading: { fill: isHeader ? '2D435D' : index % 2 === 0 ? 'F4F6F8' : 'FFFFFF' },
            borders: { top: border, bottom: border, left: border, right: border },
            children: text.split('\n').map(
              (line) =>
                new Paragraph({
                  children: [
                    new TextRun({
                      text: line,
                      bold: isHeader,
                      color: isHeader ? 'FFFFFF' : '000000',
                      size: 20,
                    }),
                  ],
                  alignment: isHeader
                    ? AlignmentType.LEFT
                    : block.columns[columnIndex]?.align === 'right'
                      ? AlignmentType.RIGHT
                      : block.columns[columnIndex]?.align === 'center'
                        ? AlignmentType.CENTER
                        : AlignmentType.LEFT,
                  spacing: { before: 0, after: 40, line: 250 },
                  widowControl: true,
                }),
            ),
          }),
      ),
    });
  return [
    new Paragraph({
      children: [new TextRun({ text: block.caption, bold: true, color: '000000', size: 22 })],
      keepNext: true,
      spacing: { before: 160, after: 100 },
    }),
    new Table({
      width: { size: contentWidth, type: WidthType.DXA },
      columnWidths: widths,
      layout: TableLayoutType.FIXED,
      borders,
      rows: [
        row(
          block.columns.map((column) => column.title),
          true,
          0,
        ),
        ...block.rows.map((values, index) => row(values, false, index)),
      ],
    }),
    new Paragraph({
      spacing: { before: 0, after: 80 },
      children: [new TextRun({ text: '', size: 4 })],
    }),
  ];
}

export async function buildRoadmapDocx(
  prepared: PreparedRoadmapExport,
  options: DocxExportOptions,
): Promise<Uint8Array> {
  const children: FileChild[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: prepared.title, bold: true, color: '000000', size: 42 })],
      spacing: { after: 180 },
      keepNext: true,
    }),
    new Paragraph({
      children: [new TextRun({ text: prepared.subtitle, color: '000000', size: 28 })],
      spacing: { after: 280 },
      keepNext: true,
    }),
  ];
  for (const block of prepared.blocks) {
    if (block.kind === 'heading') {
      children.push(
        new Paragraph({
          heading:
            block.level === 1
              ? HeadingLevel.HEADING_1
              : block.level === 2
                ? HeadingLevel.HEADING_2
                : HeadingLevel.HEADING_3,
          children: [
            new TextRun({
              text: block.text,
              color: '000000',
              bold: true,
              size: block.level === 1 ? 29 : block.level === 2 ? 25 : 23,
            }),
          ],
          keepNext: true,
          keepLines: true,
          spacing: { before: block.level === 1 ? 320 : 220, after: 120 },
        }),
      );
    } else if (block.kind === 'paragraph') {
      children.push(
        textParagraph(block.text, {
          label: block.label,
          quote: block.role === 'quote',
          size: block.role === 'meta' ? 20 : 22,
          color: block.role === 'meta' ? '465366' : '000000',
        }),
      );
    } else if (block.kind === 'table') {
      children.push(...reportTable(block));
    } else {
      const figure = block.figure;
      const svg = figureSvg(figure);
      const png = await options.rasterizeSvg(svg, figure.width * 2, figure.height * 2);
      if (png.length < 8 || png[0] !== 137 || png[1] !== 80 || png[2] !== 78 || png[3] !== 71)
        throw new Error('Не удалось подготовить изображение графика для DOCX.');
      const imageWidth = contentWidth / 15;
      const image = new ImageRun({
        type: 'svg',
        data: new TextEncoder().encode(svg),
        fallback: { type: 'png', data: png },
        transformation: { width: imageWidth, height: (imageWidth * figure.height) / figure.width },
        altText: { name: figure.id, title: figure.title, description: figure.altText },
      });
      children.push(
        new Paragraph({
          children: [new TextRun({ text: figure.title, bold: true, color: '000000', size: 22 })],
          keepNext: true,
          spacing: { before: 180, after: 100 },
        }),
      );
      children.push(new Paragraph({ children: [image], keepLines: true, spacing: { after: 80 } }));
      children.push(textParagraph(figure.altText, { size: 20, color: '465366', after: 160 }));
    }
  }
  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun({
            text: `Версия ${prepared.version.number} · ${prepared.version.sha256.slice(0, 12)} · `,
            size: 17,
            color: '465366',
          }),
          new TextRun({
            children: [PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES],
            size: 17,
            color: '465366',
          }),
        ],
      }),
    ],
  });
  const document = new Document({
    title: `${prepared.title} ${prepared.subtitle}`,
    subject: 'Зафиксированная дорожная карта демографического проекта',
    creator: 'Демографическая мастерская',
    lastModifiedBy: 'Демографическая мастерская',
    description: `Версия ${prepared.version.number}; SHA-256 канонического снимка ${prepared.version.sha256}`,
    revision: prepared.version.number,
    customProperties: [
      { name: 'RoadmapVersionId', value: prepared.version.id },
      { name: 'CanonicalSnapshotSHA256', value: prepared.version.sha256 },
      { name: 'CalculationVersion', value: prepared.version.snapshot.calculationVersion },
      { name: 'ExportVersion', value: prepared.exportVersion },
    ],
    features: { updateFields: true },
    styles: {
      default: {
        document: {
          run: { font: 'Arial', size: 22, color: '000000' },
          paragraph: { spacing: { after: 120, line: 282 } },
        },
        title: {
          run: { color: '000000', size: 42, bold: true },
          paragraph: { spacing: { after: 180 }, keepNext: true },
        },
        heading1: {
          run: { color: '000000', size: 29, bold: true },
          paragraph: { spacing: { before: 320, after: 120 }, keepNext: true },
        },
        heading2: {
          run: { color: '000000', size: 25, bold: true },
          paragraph: { spacing: { before: 220, after: 120 }, keepNext: true },
        },
        heading3: {
          run: { color: '000000', size: 23, bold: true },
          paragraph: { spacing: { before: 220, after: 120 }, keepNext: true },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: pageWidth, height: 16838 },
            margin: { top: 1080, bottom: 1080, left: 1080, right: 1080, footer: 480, header: 480 },
          },
        },
        footers: { default: footer },
        children,
      },
    ],
  });
  return new Uint8Array(await Packer.toArrayBuffer(document));
}

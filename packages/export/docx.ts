import {
  AlignmentType,
  BorderStyle,
  Document,
  Header,
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
import { roadmapLayout, twips } from './layout';
import type { DocxExportOptions, PreparedRoadmapExport, ReportBlock } from './types';

const pageWidth = twips(roadmapLayout.page.width);
const pageHeight = twips(roadmapLayout.page.height);
const margins = {
  top: twips(roadmapLayout.margin.top),
  right: twips(roadmapLayout.margin.right),
  bottom: twips(roadmapLayout.margin.bottom),
  left: twips(roadmapLayout.margin.left),
  header: twips(roadmapLayout.margin.header),
};
const contentWidth = pageWidth - margins.left - margins.right;
const contentHeight = pageHeight - margins.top - margins.bottom;
const indent = { firstLine: twips(roadmapLayout.firstLineIndent) };
const bodySize = roadmapLayout.bodySize * 2;
const bodySpacing = { line: roadmapLayout.lineSpacing * 240, after: 0 };
const border = { style: BorderStyle.SINGLE, size: 4, color: 'A0A0A0' };
const borders = {
  top: border,
  bottom: border,
  left: border,
  right: border,
  insideHorizontal: border,
  insideVertical: border,
};

function textParagraphs(block: Extract<ReportBlock, { kind: 'paragraph' }>): Paragraph[] {
  return block.text.split(/\r\n?|\n/u).map((line, index) => {
    const label = index === 0 && block.label;
    const isMeta = block.role === 'meta';
    return new Paragraph({
      children: [
        ...(label ? [new TextRun({ text: `${label}. `, bold: true })] : []),
        new TextRun({ text: line, italics: block.role === 'quote' }),
      ],
      alignment: isMeta ? AlignmentType.CENTER : AlignmentType.JUSTIFIED,
      indent: isMeta ? undefined : indent,
      spacing: bodySpacing,
      widowControl: true,
    });
  });
}

function reportTable(block: Extract<ReportBlock, { kind: 'table' }>, number: number): FileChild[] {
  const totalWeight = block.columns.reduce((sum, column) => sum + column.weight, 0);
  const widths = block.columns.map((column) =>
    Math.round((contentWidth * column.weight) / totalWeight),
  );
  widths[widths.length - 1]! += contentWidth - widths.reduce((a, b) => a + b, 0);
  const row = (values: string[], isHeader: boolean) =>
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
            shading: isHeader ? { fill: 'F3F3F3' } : undefined,
            borders: { top: border, bottom: border, left: border, right: border },
            children: text.split('\n').map(
              (line) =>
                new Paragraph({
                  children: [
                    new TextRun({
                      text: line,
                      bold: isHeader,
                      size: roadmapLayout.tableSize * 2,
                    }),
                  ],
                  alignment: isHeader
                    ? AlignmentType.LEFT
                    : block.columns[columnIndex]?.align === 'right'
                      ? AlignmentType.RIGHT
                      : block.columns[columnIndex]?.align === 'center'
                        ? AlignmentType.CENTER
                        : AlignmentType.LEFT,
                  spacing: { before: 0, after: 0, line: 240 },
                  widowControl: true,
                }),
            ),
          }),
      ),
    });
  return [
    new Paragraph({
      children: [new TextRun({ text: `Таблица ${number} — ${block.caption}` })],
      keepNext: true,
      keepLines: true,
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
        ),
        ...block.rows.map((values) => row(values, false)),
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
      children: [new TextRun({ text: prepared.title, bold: true })],
      alignment: AlignmentType.CENTER,
      spacing: { ...bodySpacing, after: 120 },
      keepNext: true,
      keepLines: true,
    }),
  ];
  if (prepared.subtitle)
    children.push(
      new Paragraph({
        children: [new TextRun(prepared.subtitle)],
        alignment: AlignmentType.CENTER,
        spacing: { ...bodySpacing, after: 120 },
        keepNext: true,
      }),
    );
  let tableNumber = 0;
  let figureNumber = 0;
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
          children: [new TextRun({ text: block.text, bold: true })],
          alignment: block.level === 1 ? AlignmentType.CENTER : AlignmentType.LEFT,
          indent: block.level === 1 ? undefined : indent,
          keepNext: true,
          keepLines: true,
          spacing: { ...bodySpacing, before: block.level === 1 ? 240 : 160, after: 80 },
        }),
      );
    } else if (block.kind === 'paragraph') {
      children.push(...textParagraphs(block));
    } else if (block.kind === 'table') {
      children.push(...reportTable(block, ++tableNumber));
    } else {
      const figure = block.figure;
      const svg = figureSvg(figure);
      const png = await options.rasterizeSvg(svg, figure.width * 2, figure.height * 2);
      if (png.length < 8 || png[0] !== 137 || png[1] !== 80 || png[2] !== 78 || png[3] !== 71)
        throw new Error('Не удалось подготовить изображение графика для DOCX.');
      const imageScale = Math.min(
        contentWidth / 15 / figure.width,
        (contentHeight - twips(20)) / 15 / figure.height,
      );
      const image = new ImageRun({
        type: 'svg',
        data: new TextEncoder().encode(svg),
        fallback: { type: 'png', data: png },
        transformation: { width: figure.width * imageScale, height: figure.height * imageScale },
        altText: { name: figure.title, title: figure.title, description: figure.altText },
      });
      children.push(
        new Paragraph({
          children: [image],
          alignment: AlignmentType.CENTER,
          keepNext: true,
          keepLines: true,
          spacing: { before: 140, after: 0, line: 240 },
        }),
        new Paragraph({
          children: [new TextRun(`Рисунок ${++figureNumber} — ${figure.title}`)],
          alignment: AlignmentType.CENTER,
          keepLines: true,
          spacing: { ...bodySpacing, after: 140 },
        }),
      );
    }
  }
  const header = new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        indent: { right: margins.left - margins.right },
        spacing: { line: 240, after: 0, before: 0 },
        children: [
          new TextRun({ children: [PageNumber.CURRENT] }),
        ],
      }),
    ],
  });
  const headingStyle = { run: { font: roadmapLayout.font, size: bodySize, bold: true } };
  const document = new Document({
    title: [prepared.title, prepared.subtitle].filter(Boolean).join(' — '),
    subject: 'Дорожная карта демографического проекта',
    creator: 'Демографическая мастерская',
    lastModifiedBy: 'Демографическая мастерская',
    features: { updateFields: true },
    styles: {
      default: {
        document: {
          run: {
            font: roadmapLayout.font,
            size: bodySize,
            color: '000000',
            language: { value: 'ru-RU' },
          },
          paragraph: { spacing: bodySpacing },
        },
        title: headingStyle,
        heading1: headingStyle,
        heading2: headingStyle,
        heading3: headingStyle,
      },
    },
    sections: [
      {
        properties: {
          titlePage: true,
          page: {
            size: { width: pageWidth, height: pageHeight },
            margin: margins,
          },
        },
        headers: { default: header, first: new Header({ children: [new Paragraph('')] }) },
        children,
      },
    ],
  });
  return new Uint8Array(await Packer.toArrayBuffer(document));
}

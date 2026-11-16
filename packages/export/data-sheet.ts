import { strToU8, zipSync } from 'fflate';

export type DataCell = string | number | null;
export type DataRows = readonly (readonly DataCell[])[];

const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const relations = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const pkgRelations = 'http://schemas.openxmlformats.org/package/2006/relationships';
const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
const xml = (text: string) => text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/gu, '')
  .replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]!));
const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function column(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : `${column(Math.floor(index / 26) - 1)}${column(index % 26)}`;
}

/** A simple worksheet. Strings are always data, including ones starting with = or +. */
export function exportDataSheet(rows: DataRows, title?: string): Uint8Array {
  const numColumns = rows.reduce((count, row) => Math.max(count, row.length), 0);
  if (!rows.length || !numColumns || numColumns > 16384 || rows.length > 1048576)
    throw new Error('В таблице нет данных или она превышает допустимый размер Excel.');
  const workbookName = xml((title ?? '').replace(/[\[\]:*?/\\]/gu, ' ').replace(/^'+|'+$/gu, '').trim().slice(0, 31)) || 'Данные';
  const columnDefinitions = Array.from({ length: numColumns }, (_, i) => {
    const width = rows.reduce((length, row) => Math.max(length, String(row[i] ?? '').length), 8);
    return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(58, Math.max(12, width + 3))}" customWidth="1"/>`;
  }).join('');
  const sheetRows = rows.map((row, i) => `<row r="${i + 1}">${row.map((value, j) => {
    const address = `${column(j)}${i + 1}`;
    const style = i === 0 ? ' s="1"' : '';
    if (value === null) return `<c r="${address}"${style}/>`;
    if (typeof value === 'number') return Number.isFinite(value) ? `<c r="${address}"${style}><v>${value}</v></c>` : `<c r="${address}"/>`;
    return `<c r="${address}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const files: Record<string, string> = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${mime}.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${mime}.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="${mime}.styles+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${pkgRelations}"><Relationship Id="rId1" Type="${relations}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${main}" xmlns:r="${relations}"><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="${workbookName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${pkgRelations}"><Relationship Id="rId1" Type="${relations}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${relations}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': `<styleSheet xmlns="${main}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF16314F"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE7EFF8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${main}"><dimension ref="A1:${column(numColumns - 1)}${rows.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${columnDefinitions}</cols><sheetData>${sheetRows}</sheetData></worksheet>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, source]) => [name, strToU8(header + source)])), { level: 5 });
}

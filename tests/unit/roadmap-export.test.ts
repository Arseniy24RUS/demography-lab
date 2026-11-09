import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import {
  prepareRoadmapExport,
  roadmapJson,
  sha256Bytes,
  sha256Text,
} from '../../packages/export/model';
import { buildRoadmapDocx } from '../../packages/export/docx';
import { buildRoadmapPdf } from '../../packages/export/pdf';
import { buildRoadmapArchive } from '../../packages/export/archive';
import { figureSvg } from '../../packages/export/figures';
import type { PdfExportFonts } from '../../packages/export/types';
import { makeRoadmapExportFixture, resealFixture, uuid } from './roadmap-export.fixture';

const decoder = new TextDecoder();
const fonts: PdfExportFonts = {
  regular: new Uint8Array(
    readFileSync(new URL('../../public/fonts/DejaVuSans.ttf', import.meta.url)),
  ),
  bold: new Uint8Array(
    readFileSync(new URL('../../public/fonts/DejaVuSans-Bold.ttf', import.meta.url)),
  ),
  license: readFileSync(new URL('../../public/fonts/LICENSE-DejaVu.txt', import.meta.url), 'utf8'),
};
// Rendering fidelity uses the full-size browser or sharp rasterizer in the visual QA sample.
const tinyPng = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=',
    'base64',
  ),
);
const rasterizeSvg = async () => tinyPng;

describe('immutable roadmap export', () => {
  it('verifies the exact canonical bytes and rejects a stale hash or divergent snapshot', async () => {
    const version = await makeRoadmapExportFixture();
    await expect(
      prepareRoadmapExport({ ...version, canonicalJson: version.canonicalJson + '\n' }),
    ).rejects.toThrow('Контрольная сумма');
    const changed = structuredClone(version);
    changed.snapshot.teamNames.push('Посторонний автор');
    await expect(prepareRoadmapExport(changed)).rejects.toThrow('каноническому');
    const pretty = { ...version, canonicalJson: JSON.stringify(version.snapshot, null, 2) };
    pretty.sha256 = await sha256Text(pretty.canonicalJson);
    expect((await prepareRoadmapExport(pretty)).version.sha256).toBe(pretty.sha256);
  });

  it('uses a deep frozen copy and includes all eight sections, sources, regional differences and archived records', async () => {
    const version = await makeRoadmapExportFixture();
    const prepared = await prepareRoadmapExport(version);
    expect(
      prepared.blocks.filter((block) => block.kind === 'heading' && /^[1-8] /u.test(block.text)),
    ).toHaveLength(8);
    expect(Object.isFrozen(prepared.version.snapshot.items)).toBe(true);
    version.snapshot.teamNames[0] = 'Изменённое живое значение';
    expect(prepared.version.snapshot.teamNames[0]).toBe('Иванова Мария Петровна');
    const json = JSON.parse(roadmapJson(prepared));
    expect(json.snapshot.evidence[0].variants).toHaveLength(2);
    expect(json.snapshot.evidence[0].variants[0].bundle.practice.amount).toBe('200 рублей за час');
    expect(json.snapshot.evidence[0].variants[1].bundle.practice.amount).toBe('350 рублей за час');
    expect(json.snapshot.items.some((row: { status: string }) => row.status === 'archived')).toBe(
      true,
    );
    expect(json.calculations.budget.totals.confirmedGapKopecks).toBe(22000000);
    expect(json.calculations.scenarios[0].result.baselineYear).toBe(2022);
    expect(json.snapshot.series[0].points.at(-1)).toEqual({ year: 2023, value: null });
    const paragraphs = prepared.blocks
      .map((block) => (block.kind === 'paragraph' ? `${block.label}: ${block.text}` : ''))
      .join('\n');
    expect(paragraphs).toContain('Блок block-1; символы [0,');
    expect(paragraphs).toContain('Архивный пример риска');
    expect(paragraphs).not.toMatch(/страница 1/u);
  });

  it('blocks a financial total inconsistent with active lines even when the snapshot hash is valid', async () => {
    const version = await makeRoadmapExportFixture();
    const cost = version.snapshot.items.find((row) => row.id === uuid(50))!;
    if (cost.kind !== 'cost') throw new Error('fixture');
    cost.data.unitPriceKopecks = 130000;
    await resealFixture(version);
    await expect(prepareRoadmapExport(version)).rejects.toThrow('сметы не совпадает');
  });

  it('does not permit a claimed registry fact to diverge from the frozen source year and value', async () => {
    const version = await makeRoadmapExportFixture();
    const fact = version.snapshot.items.find((row) => row.id === uuid(10))!;
    if (fact.kind !== 'fact') throw new Error('fixture');
    fact.data.value = 999;
    await resealFixture(version);
    await expect(prepareRoadmapExport(version)).rejects.toThrow('Статистический факт');
  });

  it('rejects unreferenced or missing evidence and unexpected sensitive fields', async () => {
    const missing = await makeRoadmapExportFixture();
    missing.snapshot.evidence = [];
    await resealFixture(missing);
    await expect(prepareRoadmapExport(missing)).rejects.toThrow();
    const extra = await makeRoadmapExportFixture();
    Object.assign(extra.snapshot, { surveyAnswers: ['private response'] });
    await resealFixture(extra);
    await expect(prepareRoadmapExport(extra)).rejects.toThrow();
  });

  it('creates editable OOXML with repeated table headers, native text, full citations and a PNG fallback for every SVG', async () => {
    const prepared = await prepareRoadmapExport(await makeRoadmapExportFixture());
    const bytes = await buildRoadmapDocx(prepared, { rasterizeSvg });
    const files = unzipSync(bytes);
    const document = decoder.decode(files['word/document.xml']);
    const custom = decoder.decode(files['docProps/custom.xml']);
    expect(document).toContain('Дорожная карта демографического проекта');
    expect(document).toContain('8 Мониторинг и оценка');
    expect(document).toContain('200 рублей за час');
    expect(document).toContain('350 рублей за час');
    expect(document).toContain('Порядок обращения определяется отдельно.');
    expect(document).toContain('w:tblHeader');
    expect(document).toContain('w:color="D9D9D9"');
    expect(document).toContain('w:pStyle'); // paragraph styles remain native editable OOXML
    expect(custom).toContain(prepared.version.sha256);
    expect(
      Object.keys(files).filter((path) => path.startsWith('word/media/') && path.endsWith('.svg')),
    ).toHaveLength(prepared.figures.length);
    expect(
      Object.keys(files).some((path) => path.startsWith('word/media/') && path.endsWith('.png')),
    ).toBe(true);
    expect(document).not.toContain('<w:altChunk');
  });

  it('creates a real multi-page PDF with embedded Cyrillic fonts, ToUnicode maps and an exact canonical attachment', async () => {
    const prepared = await prepareRoadmapExport(await makeRoadmapExportFixture());
    const bytes = await buildRoadmapPdf(prepared, fonts);
    expect(decoder.decode(bytes.slice(0, 8))).toMatch(/^%PDF-1\./u);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(5);
    const objects = pdf.context.enumerateIndirectObjects();
    expect(
      objects.some(([, value]) => value instanceof PDFDict && value.has(PDFName.of('ToUnicode'))),
    ).toBe(true);
    expect(
      objects.some(([, value]) => value instanceof PDFDict && value.has(PDFName.of('FontFile2'))),
    ).toBe(true);
    const names = pdf.catalog
      .lookup(PDFName.of('Names'), PDFDict)
      .lookup(PDFName.of('EmbeddedFiles'), PDFDict)
      .lookup(PDFName.of('Names'), PDFArray);
    const attachment = names
      .lookup(1, PDFDict)
      .lookup(PDFName.of('EF'), PDFDict)
      .lookup(PDFName.of('F'));
    if (!(attachment instanceof PDFRawStream))
      throw new Error('PDF attachment is not a raw stream');
    const attached = decodePDFRawStream(attachment).decode();
    expect(decoder.decode(attached)).toBe(prepared.version.canonicalJson);
    expect(await sha256Bytes(attached)).toBe(prepared.version.sha256);
  });

  it('packages files from one snapshot and verifies every manifest checksum', async () => {
    const prepared = await prepareRoadmapExport(await makeRoadmapExportFixture());
    const files = unzipSync(await buildRoadmapArchive(prepared, { rasterizeSvg, fonts }));
    const manifest = JSON.parse(decoder.decode(files['manifest.json']));
    expect(manifest.canonicalSha256).toBe(prepared.version.sha256);
    for (const file of manifest.files as Array<{ path: string; bytes: number; sha256: string }>) {
      expect(files[file.path]!.byteLength).toBe(file.bytes);
      expect(await sha256Bytes(files[file.path]!)).toBe(file.sha256);
    }
    expect(decoder.decode(files['canonical.json'])).toBe(prepared.version.canonicalJson);
    expect(decoder.decode(files['FONT-LICENSE.txt'])).toContain('Bitstream');
    expect(decoder.decode(files['SHA256SUMS.txt'])).toContain('  manifest.json');
  });

  it('escapes figure markup and reports unsupported glyphs without silently replacing source text', async () => {
    const version = await makeRoadmapExportFixture();
    const prepared = await prepareRoadmapExport(version);
    const figure = structuredClone(prepared.figures[0]!);
    figure.title = '<script>alert("x")</script>';
    const svg = figureSvg(figure);
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).not.toContain('<script>');
    const passport = version.snapshot.items.find((row) => row.kind === 'passport')!;
    if (passport.kind !== 'passport') throw new Error('fixture');
    passport.data.title += ' \u{1F476}';
    const unsupported = await prepareRoadmapExport(await resealFixture(version));
    await expect(buildRoadmapPdf(unsupported, fonts)).rejects.toThrow('U+1F476');
    expect(roadmapJson(unsupported)).toContain('\u{1F476}');
  });
});

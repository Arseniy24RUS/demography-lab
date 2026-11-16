import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
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
import { canonicalSeriesFingerprint } from '../../packages/territories/series.mjs';
import type { PdfExportFonts } from '../../packages/export/types';
import { makeRoadmapExportFixture, resealFixture, uuid } from './roadmap-export.fixture';

const decoder = new TextDecoder();
const fonts: PdfExportFonts = {
  regular: new Uint8Array(
    readFileSync(new URL('../../public/fonts/LiberationSerif-Regular.ttf', import.meta.url)),
  ),
  bold: new Uint8Array(
    readFileSync(new URL('../../public/fonts/LiberationSerif-Bold.ttf', import.meta.url)),
  ),
  license: readFileSync(new URL('../../public/fonts/LICENSE-Liberation.txt', import.meta.url), 'utf8'),
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

  it('prints the planning document from a frozen copy and preserves technical audit data in JSON', async () => {
    const version = await makeRoadmapExportFixture();
    const prepared = await prepareRoadmapExport(version);
    expect(
      prepared.blocks.flatMap((block) => block.kind === 'heading' && block.level === 1 ? [block.text] : []),
    ).toEqual([
      '1 Паспорт проекта',
      '2 Проблемы и обоснование мер',
      '3 Демографическая статистика',
      '4 Демографический прогноз',
      '5 Целевые показатели',
      '6 План мероприятий',
      '7 Календарный план',
      '8 Ресурсное обеспечение',
      '9 Риски и меры реагирования',
      '10 Мониторинг и оценка',
    ]);
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
    expect(json.snapshot.items.find((row: { kind: string }) => row.kind === 'passport').data.defenseDate).toBe('2026-11-10');
    const report = JSON.stringify(prepared.blocks);
    for (const text of ['200 рублей за час', '350 рублей за час',
      'Координатор проекта', 'Помещение учреждения', 'Публичное описание услуги']) {
      expect(report).toContain(text);
    }
    for (const text of ['Дата защиты', 'Закреплённый ряд', 'SHA256', 'https://example.test',
      'Блок block-1', 'Архивный пример риска', 'example-source-v1', version.sha256]) {
      expect(report).not.toContain(text);
    }
  });

  it('selects sections and their figures without changing the verified version', async () => {
    const version = await makeRoadmapExportFixture();
    const full = await prepareRoadmapExport(version);
    const forecast = await prepareRoadmapExport(version, { sections: ['forecast', 'statistics'] });
    expect(forecast.blocks.flatMap((block) => block.kind === 'heading' && block.level === 1 ? [block.text] : []))
      .toEqual(['1 Демографическая статистика', '2 Демографический прогноз']);
    expect(forecast.figures.map(({ kind }) => kind)).toEqual(['statistics', 'scenario']);
    expect(JSON.stringify(forecast.blocks)).not.toContain('Иванова Мария Петровна');
    expect(roadmapJson(forecast)).toBe(roadmapJson(full));
    const calendar = await prepareRoadmapExport(version, { sections: ['calendar'] });
    expect(calendar.figures.every(({ kind }) => kind === 'calendar')).toBe(true);
    expect(calendar.figures.length).toBeGreaterThan(0);
  });

  it('adds verified publication data only for the current territory and keeps the sealed series', async () => {
    const version = await makeRoadmapExportFixture();
    const original = version.snapshot.series[0]!;
    if (original.sourceKind === 'team_reported') throw new Error('fixture');
    const published = {
      ...original,
      id: 'published-deaths',
      metricId: 'deaths_total' as const,
      title: 'Число умерших',
      comparabilityNote: 'БДМО, выпуск 28.09.2026.',
    };
    published.fingerprint = await canonicalSeriesFingerprint(published);
    const archived = await prepareRoadmapExport(version, { sections: ['statistics'] });
    const current = await prepareRoadmapExport(version, {
      sections: ['statistics'],
      publishedStatistics: [published, { ...published, territoryKey: 'other-territory' }],
    });
    expect(archived.figures).toHaveLength(1);
    expect(current.figures.map(({ id }) => id)).toEqual([original.id, published.id]);
    expect(roadmapJson(current)).toBe(roadmapJson(archived));
    expect(JSON.stringify(current.blocks)).toContain('Базы данных показателей муниципальных образований Росстата');
    await expect(prepareRoadmapExport(version, {
      publishedStatistics: [{ ...published, fingerprint: '0'.repeat(64) }],
    })).rejects.toThrow('Опубликованный статистический ряд не прошёл проверку');
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

  it('creates editable OOXML with document styles, numbered figures and repeated table captions', async () => {
    const version = await makeRoadmapExportFixture();
    const passport = version.snapshot.items.find(row => row.kind === 'passport');
    if (passport?.kind !== 'passport') throw new Error('fixture');
    passport.data.technologyResources = 'Цифровая форма записи';
    const prepared = await prepareRoadmapExport(await resealFixture(version));
    const bytes = await buildRoadmapDocx(prepared, { rasterizeSvg });
    const files = unzipSync(bytes);
    const document = decoder.decode(files['word/document.xml']);
    const styles = decoder.decode(files['word/styles.xml']);
    const headers = Object.keys(files).filter((name) => /^word\/header\d+\.xml$/u.test(name));
    expect(document).toContain('Дорожная карта демографического проекта');
    expect(document).toContain('10 Мониторинг и оценка');
    expect(document).toContain('200 рублей за час');
    expect(document).toContain('350 рублей за час');
    expect(document).not.toContain('Дата защиты');
    expect(document).toContain('Технологический ресурс');
    expect(document).toContain('Цифровая форма записи');
    expect(document).toContain('w:tblHeader');
    expect(document).toContain('w:pStyle'); // paragraph styles remain native editable OOXML
    expect(document).toContain('<w:jc w:val="both"');
    expect(document).toContain('w:firstLine="709"');
    expect(document).toContain('w:line="360"');
    expect(document).toContain('<w:titlePg');
    expect(styles).toContain('w:ascii="Times New Roman"');
    expect(styles).toContain('<w:sz w:val="28"');
    expect(headers.map((name) => decoder.decode(files[name])).join('')).toContain('PAGE');
    expect(document).toContain('Таблица 1 —');
    expect(document).toContain('Рисунок 1 —');
    for (const [name, data] of Object.entries(files)) {
      if (name.endsWith('.xml')) expect(decoder.decode(data)).not.toContain(prepared.version.sha256);
    }
    expect(
      Object.keys(files).filter((path) => path.startsWith('word/media/') && path.endsWith('.svg')),
    ).toHaveLength(prepared.figures.length);
    expect(
      Object.keys(files).some((path) => path.startsWith('word/media/') && path.endsWith('.png')),
    ).toBe(true);
    expect(document).not.toContain('<w:altChunk');
  });

  it('creates an A4 PDF with embedded Cyrillic serif fonts and no internal attachments', async () => {
    const prepared = await prepareRoadmapExport(await makeRoadmapExportFixture());
    const bytes = await buildRoadmapPdf(prepared, fonts);
    expect(decoder.decode(bytes.slice(0, 8))).toMatch(/^%PDF-1\./u);
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(5);
    expect(pdf.getPage(0).getWidth()).toBeCloseTo(595.28, 2);
    expect(pdf.getPage(0).getHeight()).toBeCloseTo(841.89, 2);
    const objects = pdf.context.enumerateIndirectObjects();
    expect(
      objects.some(([, value]) => value instanceof PDFDict && value.has(PDFName.of('ToUnicode'))),
    ).toBe(true);
    expect(
      objects.some(([, value]) => value instanceof PDFDict && value.has(PDFName.of('FontFile2'))),
    ).toBe(true);
    expect(
      objects.some(([, value]) => value instanceof PDFDict &&
        String(value.get(PDFName.of('BaseFont'))).includes('LiberationSerif')),
    ).toBe(true);
    expect(pdf.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)?.has(PDFName.of('EmbeddedFiles')))
      .toBeFalsy();
    expect(pdf.getSubject()).toBe('Дорожная карта демографического проекта');
    expect(pdf.getKeywords()).toBeUndefined();
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
    expect(decoder.decode(files['FONT-LICENSE.txt'])).toContain('SIL OPEN FONT LICENSE');
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

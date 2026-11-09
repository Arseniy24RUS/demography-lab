import { zipSync } from 'fflate';
import type { Zippable } from 'fflate';
import { buildRoadmapDocx } from './docx';
import { buildRoadmapPdf } from './pdf';
import { figureSvg } from './figures';
import { roadmapJson, sha256Bytes } from './model';
import type { DocxExportOptions, PdfExportFonts, PreparedRoadmapExport } from './types';

const encode = (text: string) => new TextEncoder().encode(text);

export async function buildRoadmapArchive(
  prepared: PreparedRoadmapExport,
  options: DocxExportOptions & { fonts: PdfExportFonts },
): Promise<Uint8Array> {
  // Both renderers receive the same verified and frozen object, not a second live RPC result.
  const files: Record<string, Uint8Array> = {
    'roadmap.docx': await buildRoadmapDocx(prepared, options),
    'roadmap.pdf': await buildRoadmapPdf(prepared, options.fonts),
    'roadmap.json': encode(roadmapJson(prepared)),
    'canonical.json': encode(prepared.version.canonicalJson),
    'FONT-LICENSE.txt': encode(options.fonts.license),
  };
  for (const figure of prepared.figures)
    files[`figures/${figure.id}.svg`] = encode(figureSvg(figure));
  files['README.txt'] = encode(
    `Демографическая мастерская\nВерсия дорожной карты ${prepared.version.number}\nТерритория: ${prepared.version.snapshot.territory.name}\n\n` +
      `SHA-256 точных UTF-8 байтов canonical.json:\n${prepared.version.sha256}\n\n` +
      'roadmap.docx и roadmap.pdf содержат одну сохранённую версию. В PDF встроены selectable-текст, шрифты DejaVu Sans и вложение canonical.json.\n' +
      'roadmap.json сохраняет полный снимок, точный canonicalJson, расчёты, исходные ряды, документальные основания и предупреждения.\n' +
      'canonical.json нельзя форматировать перед проверкой контрольной суммы: даже изменение пробелов изменит SHA-256.\n' +
      'manifest.json связывает файлы с версией. SHA256SUMS.txt содержит суммы файлов архива, включая manifest.json, но не самого списка.\n' +
      'Проверка в Linux: sha256sum -c SHA256SUMS.txt\nПроверка отдельного снимка в PowerShell: Get-FileHash canonical.json -Algorithm SHA256\n\n' +
      'Разность целевой и базовой траекторий является плановым разрывом, не причинным эффектом мероприятий. Денежные расчёты выполняются в целых копейках с округлением half-up по строке.\n' +
      'Комплектность документа не является экспертизой научной обоснованности, текущих полномочий или бюджетных ассигнований. Исторические региональные документы не удостоверяют актуальное право на поддержку.\n' +
      'Контрольные суммы удостоверяют совпадение файлов с полученным снимком; электронную подпись они не заменяют. Состояние отдельной рецензии преподавателя в эту выгрузку не включается.\n',
  );
  const checksums: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const path of Object.keys(files).sort())
    checksums.push({
      path,
      bytes: files[path]!.byteLength,
      sha256: await sha256Bytes(files[path]!),
    });
  const manifest = {
    exportVersion: prepared.exportVersion,
    versionId: prepared.version.id,
    versionNumber: prepared.version.number,
    roadmapRevision: prepared.version.roadmapRevision,
    territoryKey: prepared.version.snapshot.territory.key,
    frozenAt: prepared.version.createdAt,
    templateVersion: prepared.version.snapshot.templateVersion,
    calculationVersion: prepared.version.snapshot.calculationVersion,
    canonicalSha256: prepared.version.sha256,
    files: checksums,
  };
  files['manifest.json'] = encode(JSON.stringify(manifest, null, 2) + '\n');
  checksums.push({
    path: 'manifest.json',
    bytes: files['manifest.json'].byteLength,
    sha256: await sha256Bytes(files['manifest.json']),
  });
  files['SHA256SUMS.txt'] = encode(
    checksums.map((row) => `${row.sha256}  ${row.path}`).join('\n') + '\n',
  );
  const archive: Zippable = {};
  // ZIP's DOS date range starts in 1980; source timestamps are validated separately.
  const frozenDate = new Date(prepared.version.createdAt);
  const mtime =
    frozenDate.getUTCFullYear() >= 1980 && frozenDate.getUTCFullYear() <= 2099
      ? frozenDate
      : new Date('2000-01-01T00:00:00Z');
  for (const [path, data] of Object.entries(files))
    archive[path] = [data, { level: /\.(?:pdf|docx)$/u.test(path) ? 0 : 6, mtime }];
  return zipSync(archive);
}

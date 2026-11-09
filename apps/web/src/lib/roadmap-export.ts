import type { RoadmapVersion } from '../../../../packages/roadmaps/types';
import type {
  ExportedRoadmapFile,
  PdfExportFonts,
  RoadmapExportFormat,
} from '../../../../packages/export/types';
import { prepareRoadmapExport, roadmapJson } from '../../../../packages/export/model';

export type { ExportedRoadmapFile, RoadmapExportFormat };

let cachedFonts: Promise<PdfExportFonts> | null = null;

function fontUrl(filename: string): URL {
  const url = new URL(`${import.meta.env.BASE_URL}fonts/${filename}`, document.baseURI);
  if (url.origin !== window.location.origin)
    throw new Error('Шрифты PDF должны загружаться с адреса самой платформы.');
  return url;
}
async function getFontResponse(filename: string): Promise<Response> {
  const response = await fetch(fontUrl(filename), {
    cache: 'force-cache',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok)
    throw new Error(
      `Не удалось загрузить локальный файл ${filename}. Проверьте комплектность публикации.`,
    );
  return response;
}
export async function loadRoadmapExportFonts(): Promise<PdfExportFonts> {
  if (!cachedFonts)
    cachedFonts = (async () => {
      const responses = await Promise.all([
        getFontResponse('DejaVuSans.ttf'),
        getFontResponse('DejaVuSans-Bold.ttf'),
        getFontResponse('LICENSE-DejaVu.txt'),
      ]);
      const [regular, bold, license] = await Promise.all([
        responses[0]!.arrayBuffer(),
        responses[1]!.arrayBuffer(),
        responses[2]!.text(),
      ]);
      if (regular.byteLength < 10000 || bold.byteLength < 10000 || !license.includes('Bitstream'))
        throw new Error('Локальный комплект шрифтов PDF повреждён.');
      return { regular: new Uint8Array(regular), bold: new Uint8Array(bold), license };
    })().catch((error: unknown) => {
      cachedFonts = null;
      throw error;
    });
  return cachedFonts;
}

export async function rasterizeRoadmapSvg(
  svg: string,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error('Время подготовки графика для DOCX истекло.')),
        15000,
      );
      image.onload = () => {
        window.clearTimeout(timer);
        resolve();
      };
      image.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('Браузер не смог подготовить график для DOCX.'));
      };
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Браузер не поддерживает подготовку изображений графика.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error('График DOCX не сформирован.'))),
        'image/png',
      ),
    );
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

const mimeTypes: Record<RoadmapExportFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  json: 'application/json;charset=utf-8',
  zip: 'application/zip',
};

/** Load this module on demand; no export takes a second snapshot from the live room. */
export async function exportRoadmapVersion(
  version: RoadmapVersion,
  format: RoadmapExportFormat,
): Promise<ExportedRoadmapFile> {
  const prepared = await prepareRoadmapExport(version);
  let bytes: Uint8Array;
  if (format === 'json') bytes = new TextEncoder().encode(roadmapJson(prepared));
  else if (format === 'docx') {
    const { buildRoadmapDocx } = await import('../../../../packages/export/docx');
    bytes = await buildRoadmapDocx(prepared, { rasterizeSvg: rasterizeRoadmapSvg });
  } else if (format === 'pdf') {
    const { buildRoadmapPdf } = await import('../../../../packages/export/pdf');
    bytes = await buildRoadmapPdf(prepared, await loadRoadmapExportFonts());
  } else if (format === 'zip') {
    const { buildRoadmapArchive } = await import('../../../../packages/export/archive');
    bytes = await buildRoadmapArchive(prepared, {
      rasterizeSvg: rasterizeRoadmapSvg,
      fonts: await loadRoadmapExportFonts(),
    });
  } else throw new Error('Неподдерживаемый формат экспорта.');
  const mimeType = mimeTypes[format];
  return {
    blob: new Blob([new Uint8Array(bytes).buffer], { type: mimeType }),
    filename: `${prepared.basename}.${format}`,
    mimeType,
  };
}

export async function downloadRoadmapVersion(
  version: RoadmapVersion,
  format: RoadmapExportFormat,
  canDownload: () => boolean = () => true,
): Promise<void> {
  if (!canDownload()) return;
  const file = await exportRoadmapVersion(version, format);
  // Re-check membership context after asynchronous fonts/rasterisation/rendering.
  // A detached view must not deliver a sensitive old-account file after logout.
  if (!canDownload()) return;
  const url = URL.createObjectURL(file.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Safari needs the object URL to survive the click's navigation task.
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

import type { PdfExportFonts } from '../../../../packages/export/types';

type LocalFont = { postscriptName: string; blob(): Promise<Blob> };
type LocalFontWindow = Window & {
  queryLocalFonts?: (options: { postscriptNames: string[] }) => Promise<LocalFont[]>;
};

const names = ['TimesNewRomanPSMT', 'TimesNewRomanPS-BoldMT'] as const;

function permittedEmbedding(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12) return false;
  const count = view.getUint16(4);
  if (12 + 16 * count > bytes.byteLength) return false;
  for (let i = 0; i < count; i++) {
    const at = 12 + 16 * i;
    if (view.getUint32(at) !== 0x4f532f32) continue; // OS/2
    const start = view.getUint32(at + 8), size = view.getUint32(at + 12);
    if (size < 10 || start + size > bytes.byteLength) return false;
    const permissions = view.getUint16(start + 8);
    // The renderer embeds a subset of the outline glyphs.
    return !(permissions & (0x0002 | 0x0100 | 0x0200));
  }
  return false;
}

export async function loadTimesNewRomanFiles(files: readonly Blob[]): Promise<PdfExportFonts> {
  if (files.length !== 2) throw new Error('Выберите два файла Times New Roman: обычное и полужирное начертания.');
  const { default: fontkit } = await import('@pdf-lib/fontkit');
  const data = new Map<string, Uint8Array>();
  for (const file of files) {
    if (file.size < 10000 || file.size > 12_000_000)
      throw new Error('Выберите файлы шрифта Times New Roman в формате TTF или OTF.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let name: string | undefined;
    try {
      const font = fontkit.create(bytes) as { postscriptName?: string };
      name = font.postscriptName;
    } catch { /* Invalid or unsupported local files are handled below. */ }
    if (!name || !names.some(expected => expected === name))
      throw new Error('Нужны обычное и полужирное начертания именно Times New Roman.');
    if (!permittedEmbedding(bytes)) throw new Error('Этот файл шрифта нельзя встроить в PDF.');
    data.set(name, bytes);
  }
  const regular = data.get(names[0]);
  const bold = data.get(names[1]);
  if (!regular || !bold) throw new Error('Выберите оба начертания Times New Roman.');
  return { regular, bold, license: 'Times New Roman: локальные файлы шрифта для встраивания в документ' };
}

/** Must be called from the PDF button's user gesture. Query only the two faces we use. */
export async function loadDeviceTimesNewRoman(): Promise<PdfExportFonts> {
  const query = (window as LocalFontWindow).queryLocalFonts;
  if (!query) throw new Error('Этот браузер не может открыть установленные шрифты. Выберите два файла Times New Roman или Liberation Serif.');
  let faces: LocalFont[];
  try {
    faces = await query.call(window, { postscriptNames: [...names] });
  } catch {
    throw new Error('Браузер не предоставил доступ к шрифту. Выберите файлы Times New Roman или Liberation Serif.');
  }
  const selected = names.map(name => faces.find(face => face.postscriptName === name));
  if (selected.some(face => !face)) throw new Error('На устройстве не найдены оба начертания Times New Roman. Выберите файлы шрифта или Liberation Serif.');
  return loadTimesNewRomanFiles(await Promise.all(selected.map(face => face!.blob())));
}

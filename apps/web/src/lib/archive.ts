import { strToU8, Unzip, UnzipInflate, zipSync } from 'fflate';
import { exportWorkspace, MAX_EXCHANGE_BYTES, validateWorkspaceImport } from '@/storage';
import type { WorkspaceSnapshot, WorkspaceState, ValidatedWorkspaceImport } from '@/storage';
import type { TextAnchor } from '@domain/index';

export function downloadWorkspace(snapshot: WorkspaceSnapshot) {
  const json = exportWorkspace(snapshot);
  const readme =
    'Демографическая мастерская\nРабочая тетрадь первого модуля.\n\nworkspace.json содержит цитаты, исходные редакции, карточки и решения по связям.\nИмя и email исключены. Для восстановления используйте «Моя работа → Импортировать работу».\nАрхив не удостоверяет автора. После импорта проверки полей требуют подтверждения по источнику.\n';
  const data = zipSync(
    { 'workspace.json': strToU8(json), 'README.txt': strToU8(readme) },
    { level: 6 },
  );
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `demography-workspace-${new Date().toISOString().slice(0, 10)}.zip`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 256;
const ZIP_INPUT_CHUNK_BYTES = 1024;
const WORKSPACE_NAME = strToU8('workspace.json');
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

interface WorkspaceZipEntry {
  originalSize: number;
  compressedSize: number;
  crc32: number;
  compression: number;
}

/** Read bounded ZIP metadata without trusting it as the actual inflated length. */
function workspaceZipEntry(bytes: Uint8Array): WorkspaceZipEntry {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = () => new Error('Архив ZIP повреждён или использует неподдерживаемую структуру.');
  const fits = (offset: number, length: number) =>
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    offset >= 0 &&
    length >= 0 &&
    offset + length <= bytes.length;
  const isWorkspace = (offset: number, length: number) =>
    length === WORKSPACE_NAME.length &&
    WORKSPACE_NAME.every((byte, index) => bytes[offset + index] === byte);
  if (bytes.length < 22) throw invalid();
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (
      view.getUint32(offset, true) === 0x06054b50 &&
      offset + 22 + view.getUint16(offset + 20, true) === bytes.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw invalid();
  const count = view.getUint16(end + 10, true),
    directorySize = view.getUint32(end + 12, true),
    directoryOffset = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0 ||
    view.getUint16(end + 8, true) !== count ||
    count === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  )
    throw new Error('Для импорта нужен обычный однодисковый ZIP без ZIP64.');
  if (count > MAX_ARCHIVE_ENTRIES)
    throw new Error(
      'Архив содержит слишком много записей. Сохраните отдельный архив рабочей тетради.',
    );
  if (!fits(directoryOffset, directorySize) || directoryOffset + directorySize !== end)
    throw invalid();
  let offset = directoryOffset;
  let workspace: WorkspaceZipEntry | undefined;
  for (let index = 0; index < count; index++) {
    if (!fits(offset, 46) || view.getUint32(offset, true) !== 0x02014b50) throw invalid();
    const nameLength = view.getUint16(offset + 28, true),
      extraLength = view.getUint16(offset + 30, true),
      commentLength = view.getUint16(offset + 32, true);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (!fits(offset, recordLength) || offset + recordLength > directoryOffset + directorySize)
      throw invalid();
    if (isWorkspace(offset + 46, nameLength)) {
      if (workspace)
        throw new Error(
          'В архиве несколько записей workspace.json. Импорт неоднозначного архива отменён.',
        );
      const flags = view.getUint16(offset + 8, true),
        compression = view.getUint16(offset + 10, true),
        crc32 = view.getUint32(offset + 16, true),
        compressedSize = view.getUint32(offset + 20, true),
        originalSize = view.getUint32(offset + 24, true),
        localOffset = view.getUint32(offset + 42, true);
      if (
        view.getUint16(offset + 34, true) !== 0 ||
        compressedSize === 0xffffffff ||
        originalSize === 0xffffffff ||
        localOffset === 0xffffffff
      )
        throw invalid();
      if (flags & 0x41) throw new Error('Зашифрованный workspace.json не поддерживается.');
      if (compression !== 0 && compression !== 8)
        throw new Error('Для workspace.json поддерживается хранение без сжатия или DEFLATE.');
      if (originalSize > MAX_EXCHANGE_BYTES)
        throw new Error('Рабочая тетрадь внутри архива превышает 5 МиБ.');
      if (!fits(localOffset, 30) || view.getUint32(localOffset, true) !== 0x04034b50)
        throw invalid();
      const localNameLength = view.getUint16(localOffset + 26, true),
        localExtraLength = view.getUint16(localOffset + 28, true);
      const contentOffset = localOffset + 30 + localNameLength + localExtraLength;
      if (
        !fits(localOffset, 30 + localNameLength + localExtraLength) ||
        !isWorkspace(localOffset + 30, localNameLength) ||
        !fits(contentOffset, compressedSize) ||
        contentOffset + compressedSize > directoryOffset
      )
        throw invalid();
      if (
        view.getUint16(localOffset + 6, true) !== flags ||
        view.getUint16(localOffset + 8, true) !== compression
      )
        throw invalid();
      if (
        !(flags & 8) &&
        (view.getUint32(localOffset + 14, true) !== crc32 ||
          view.getUint32(localOffset + 18, true) !== compressedSize ||
          view.getUint32(localOffset + 22, true) !== originalSize)
      )
        throw invalid();
      workspace = { originalSize, compressedSize, crc32, compression };
    }
    offset += recordLength;
  }
  if (offset !== directoryOffset + directorySize) throw invalid();
  if (!workspace)
    throw new Error(
      'В архиве отсутствует workspace.json. Выберите архив работы, сохранённый платформой.',
    );
  return workspace;
}

/** Bound actual DEFLATE output; an untrusted size header cannot truncate or authorize it. */
function unzipWorkspace(bytes: Uint8Array): Uint8Array {
  const expected = workspaceZipEntry(bytes);
  const chunks: Uint8Array[] = [];
  let length = 0,
    crc = 0xffffffff,
    workspaceCount = 0,
    fileCount = 0,
    complete = false;
  const unzip = new Unzip((file) => {
    if (++fileCount > MAX_ARCHIVE_ENTRIES) throw new Error('Архив содержит слишком много записей.');
    if (file.name !== 'workspace.json') return; // Unstarted entries are never inflated or extracted.
    if (++workspaceCount !== 1)
      throw new Error('В архиве несколько записей workspace.json. Импорт отменён.');
    if (
      file.compression !== expected.compression ||
      (file.size !== undefined && file.size !== expected.compressedSize) ||
      (file.originalSize !== undefined && file.originalSize !== expected.originalSize)
    )
      throw new Error('Заголовки workspace.json не согласованы.');
    file.ondata = (error, data, final) => {
      if (error) throw error;
      length += data.byteLength;
      if (length > MAX_EXCHANGE_BYTES)
        throw new Error('Фактический размер рабочей тетради превышает 5 МиБ.');
      if (length > expected.originalSize)
        throw new Error('Фактический размер workspace.json не совпадает с заголовком архива.');
      for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
      if (data.length) chunks.push(data.slice());
      if (final) {
        if (length !== expected.originalSize)
          throw new Error('Фактический размер workspace.json не совпадает с заголовком архива.');
        if ((crc ^ 0xffffffff) >>> 0 !== expected.crc32)
          throw new Error(
            'Контрольная сумма CRC32 файла workspace.json не совпадает. Архив повреждён.',
          );
        complete = true;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // A single giant push can inflate much more than the limit before ondata runs.
  // Bounded compressed chunks limit temporary decoder output as well as retained output.
  for (let offset = 0; offset < bytes.length; offset += ZIP_INPUT_CHUNK_BYTES) {
    const end = Math.min(bytes.length, offset + ZIP_INPUT_CHUNK_BYTES);
    unzip.push(bytes.subarray(offset, end), end === bytes.length);
  }
  if (workspaceCount !== 1 || !complete)
    throw new Error('Не удалось полностью прочитать workspace.json из архива.');
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function readWorkspaceArchive(file: File): Promise<ValidatedWorkspaceImport> {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error('Размер входного файла превышает 8 МиБ.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_ARCHIVE_BYTES)
    throw new Error('Размер входного файла превышает 8 МиБ.');
  const jsonBytes = file.name.toLowerCase().endsWith('.zip') ? unzipWorkspace(bytes) : bytes;
  if (jsonBytes.byteLength > MAX_EXCHANGE_BYTES)
    throw new Error('Рабочая тетрадь превышает 5 МиБ.');
  let json: string;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes);
  } catch {
    throw new Error('workspace.json содержит некорректный текст UTF-8.');
  }
  return validateWorkspaceImport(json);
}

function sameAnchor(left: TextAnchor, right: TextAnchor): boolean {
  return (
    left.id === right.id &&
    left.documentId === right.documentId &&
    left.versionId === right.versionId &&
    left.normalizationVersion === right.normalizationVersion &&
    left.spans.length === right.spans.length &&
    left.spans.every((span, index) => {
      const other = right.spans[index];
      return (
        span.blockId === other.blockId &&
        span.start === other.start &&
        span.end === other.end &&
        span.exact === other.exact &&
        span.prefix === other.prefix &&
        span.suffix === other.suffix
      );
    })
  );
}

export function mergeImportedWorkspace(target: WorkspaceState, incoming: WorkspaceState) {
  // Preflight every citation before adding any imported source, card or decision.
  // A duplicate entity ID cannot redirect incoming evidence to a different local quote.
  const annotations = new Map(
    target.annotations.map((annotation) => [annotation.id, annotation.anchor]),
  );
  for (const annotation of incoming.annotations) {
    const existing = annotations.get(annotation.id);
    if (existing && !sameAnchor(existing, annotation.anchor))
      throw new Error(
        'Архив содержит другую цитату под уже известным идентификатором. Импорт отменён; исходные записи сохранены.',
      );
    annotations.set(annotation.id, annotation.anchor);
  }
  for (const ref of incoming.sourceReferences) {
    const exists = target.sourceReferences.find((r) => r.editionId === ref.editionId);
    if (
      exists &&
      (exists.sourceId !== ref.sourceId ||
        exists.normalizationVersion !== ref.normalizationVersion ||
        (exists.sha256 && exists.sha256 !== ref.sha256))
    )
      throw new Error(
        'Архив содержит другую редакцию под уже известным идентификатором. Импорт отменён.',
      );
  }
  const addUnique = <T extends { id: string }>(existing: T[], imported: T[]) => {
    const ids = new Set(existing.map((x) => x.id));
    for (const item of imported)
      if (!ids.has(item.id)) {
        existing.push(structuredClone(item));
        ids.add(item.id);
      }
  };
  for (const ref of incoming.sourceReferences)
    if (!target.sourceReferences.some((r) => r.editionId === ref.editionId))
      target.sourceReferences.push(structuredClone(ref));
  addUnique(target.annotations, incoming.annotations);
  addUnique(target.customCards, incoming.customCards);
  addUnique(target.practiceProposals, incoming.practiceProposals);
  addUnique(target.linkDecisions, incoming.linkDecisions);
  addUnique(target.readingTasks, incoming.readingTasks);
}

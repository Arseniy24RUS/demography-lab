import { describe, expect, it, vi } from 'vitest';
import { strToU8, Zip, ZipDeflate, zipSync } from 'fflate';
import { createAnchor, evaluateFieldEvidence, NORMALIZATION_VERSION, type DocumentVersion } from '@domain/index';
import { mergeImportedWorkspace, readWorkspaceArchive } from '@/lib/archive';
import { localOccurrences, withLocalEvidence } from '@/lib/workspace-domain';
import {
  createEmptyWorkspace, exportWorkspace, MAX_EXCHANGE_BYTES, validateWorkspaceImport,
  validateWorkspaceState, type WorkspaceState,
} from '@/storage';

const date = '2026-11-08T13:00:00.000Z';
const source: DocumentVersion = {
  id: 'edition-1', documentId: 'document-1', normalizationVersion: NORMALIZATION_VERSION,
  sourceSha256: 'a'.repeat(64), sourceUrl: 'https://example.test/programme.pdf',
  blocks: [
    { id: 'amount', order: 0, kind: 'paragraph', text: 'Выплата составляет 100 000 рублей.' },
    { id: 'other', order: 1, kind: 'paragraph', text: 'Предусмотрены консультации по вопросам образования.' },
  ],
};

function fixture(id = 'workbook'): WorkspaceState {
  const state = createEmptyWorkspace(id);
  const anchor = createAnchor(source, [{ blockId: 'amount', start: 0, end: Array.from(source.blocks[0].text).length }]);
  state.sourceReferences = [{ sourceId: source.documentId, editionId: source.id, title: 'Программа', normalizationVersion: source.normalizationVersion, sha256: source.sourceSha256, sourceUrl: source.sourceUrl, regionId: 'ru-13' }];
  state.annotations = [{ id: 'annotation-1', anchor, note: 'Локальный комментарий', createdAt: date, updatedAt: date }];
  state.customCards = [{ id: 'card-1', familyId: 'family-1', regionId: 'ru-13', title: 'Выплата', mechanism: 'Денежная выплата', amount: '100 000 рублей', conditions: ['Проживание в регионе'], occurrenceIds: ['annotation-1'], reviewStatus: 'verified', createdAt: date, updatedAt: date }];
  state.linkDecisions = [{ id: 'link-1', annotationId: 'annotation-1', practiceId: 'card-1', status: 'verified', rationale: 'Сумма проверена в источнике.', decidedAt: date, origin: 'local', fieldEvidence: [{ kind: 'fragment', field: 'amount', occurrenceId: 'annotation-1', relation: 'supports', reviewStatus: 'verified', reviewedValue: '100 000 рублей' }] }];
  state.practiceProposals = [{ id: 'proposal-1', title: 'Предложение', summary: 'Для обсуждения', annotationIds: ['annotation-1'], createdAt: date, updatedAt: date }];
  state.readingTasks = [{ id: 'reading-edition-1', sourceEditionId: source.id, status: 'fragment-reviewed', reviewedBlockIds: ['amount'], annotationIds: ['annotation-1'], note: 'Проверен фрагмент.', updatedAt: date }];
  return state;
}

function json(state = fixture()): string {
  return exportWorkspace({ state, revision: 2, updatedAt: date }, { exportedAt: date });
}

function checkedImport(state = fixture()): WorkspaceState {
  return validateWorkspaceImport(json(state)).workspace;
}

function file(bytes: Uint8Array | string, name = 'workspace.zip'): File {
  return new File([typeof bytes === 'string' ? bytes : Uint8Array.from(bytes).buffer], name);
}

function zip(contents = json(), level: 0 | 6 = 6): Uint8Array {
  return zipSync({ 'workspace.json': strToU8(contents), 'README.txt': strToU8('Локальная рабочая тетрадь, без электронной подписи.') }, { level });
}

/** Small deterministic ZIP fixtures; all manipulated payloads remain under 6 MiB. */
function entryOffsets(bytes: Uint8Array, name: string): { central: number; local: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  for (let index = 0; index < count; index++) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    const nameLength = view.getUint16(offset + 28, true);
    const actualName = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (actualName === name) return { central: offset, local: view.getUint32(offset + 42, true) };
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  throw new Error(`Fixture entry missing: ${name}`);
}

function declareSize(bytes: Uint8Array, size: number, name = 'workspace.json'): Uint8Array {
  const output = Uint8Array.from(bytes);
  const view = new DataView(output.buffer);
  const offsets = entryOffsets(output, name);
  view.setUint32(offsets.central + 24, size, true);
  view.setUint32(offsets.local + 22, size, true);
  return output;
}

function renameEntry(bytes: Uint8Array, from: string, to: string): Uint8Array {
  const output = Uint8Array.from(bytes);
  const offsets = entryOffsets(output, from);
  const replacement = strToU8(to);
  expect(replacement.length).toBe(strToU8(from).length);
  output.set(replacement, offsets.central + 46);
  output.set(replacement, offsets.local + 30);
  return output;
}

function streamedZip(contents: string): Uint8Array {
  const parts: Uint8Array[] = [];
  const archive = new Zip((error, data) => { if (error) throw error; parts.push(data.slice()); });
  const entry = new ZipDeflate('workspace.json', { level: 6 });
  archive.add(entry);
  const data = strToU8(contents);
  entry.push(data.subarray(0, Math.floor(data.length / 2)));
  entry.push(data.subarray(Math.floor(data.length / 2)), true);
  archive.end();
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

describe('archive merge preserves evidence identity', () => {
  it('rejects a reused annotation ID with a different exact anchor before any object is merged', () => {
    const target = fixture();
    const incoming = checkedImport();
    incoming.annotations[0].anchor = createAnchor(source, [{ blockId: 'other', start: 0, end: Array.from(source.blocks[1].text).length }]);
    incoming.linkDecisions[0].id = 'incoming-link';
    incoming.sourceReferences.unshift({ sourceId: 'new-document', editionId: 'new-edition', title: 'Новый источник', normalizationVersion: NORMALIZATION_VERSION });
    incoming.annotations.unshift({ ...incoming.annotations[0], id: 'new-annotation' });
    incoming.customCards.push({ ...incoming.customCards[0], id: 'new-card' });
    const before = structuredClone(target);
    const incomingBefore = structuredClone(incoming);
    expect(() => mergeImportedWorkspace(target, incoming)).toThrow(/другую цитату/);
    expect(target).toEqual(before);
    expect(incoming).toEqual(incomingBefore);
  });

  it('accepts the exact same anchor despite reordered JSON keys and retains the local note', () => {
    const target = fixture(); const incoming = checkedImport();
    const anchor = incoming.annotations[0].anchor;
    incoming.annotations[0].anchor = {
      spans: anchor.spans.map(span => ({ suffix: span.suffix, exact: span.exact, end: span.end, blockId: span.blockId, prefix: span.prefix, start: span.start })),
      normalizationVersion: anchor.normalizationVersion, versionId: anchor.versionId, documentId: anchor.documentId, id: anchor.id,
    };
    incoming.annotations[0].note = 'Другой комментарий импортирующего участника';
    incoming.annotations[0].updatedAt = '2026-11-08T14:00:00.000Z';
    mergeImportedWorkspace(target, incoming);
    expect(target.annotations).toHaveLength(1);
    expect(target.annotations[0]).toMatchObject({ note: 'Локальный комментарий', updatedAt: date });
    expect(validateWorkspaceState(target).annotations[0].anchor).toEqual(fixture().annotations[0].anchor);
  });

  it('is idempotent, keeps local identity/preferences and owns its added objects', () => {
    const target = createEmptyWorkspace('my-local-book', 'Моя работа');
    target.profile = { displayName: 'Локальный участник' };
    target.preferences.readerFontScale = 1.25;
    const foreign = fixture('foreign-workbook');
    foreign.profile = { displayName: 'Внешний участник', email: 'foreign@example.test' };
    foreign.preferences.readerFontScale = 0.8;
    const incoming = validateWorkspaceImport(exportWorkspace({ state: foreign, revision: 7, updatedAt: date }, { includeProfile: true })).workspace;
    expect(incoming.profile?.displayName).toBe('Внешний участник');
    mergeImportedWorkspace(target, incoming);
    const once = structuredClone(target);
    mergeImportedWorkspace(target, incoming);
    expect(target).toEqual(once);
    expect(target).toMatchObject({ id: 'my-local-book', title: 'Моя работа', profile: { displayName: 'Локальный участник' }, preferences: { readerFontScale: 1.25 } });
    expect(target.annotations).toHaveLength(1);
    expect(target.customCards).toHaveLength(1);
    expect(target.linkDecisions).toHaveLength(1);
    expect(target.practiceProposals).toHaveLength(1);
    expect(target.readingTasks).toHaveLength(1);
    incoming.annotations[0].note = 'Изменён внешний объект';
    expect(target.annotations[0].note).toBe('Локальный комментарий');
    expect(validateWorkspaceState(target).sourceReferences).toHaveLength(1);
  });

  it.each(['sha256', 'sourceId', 'normalizationVersion', 'missingDigest'] as const)('rejects an edition conflict (%s) without appending preceding new references', field => {
    const target = fixture(); const incoming = createEmptyWorkspace('incoming');
    const conflict = { ...target.sourceReferences[0] };
    if (field === 'missingDigest') delete conflict.sha256;
    else conflict[field] = field === 'sha256' ? 'b'.repeat(64) : 'different-value';
    incoming.sourceReferences = [{ sourceId: 'new-doc', editionId: 'new-edition', title: 'Новый', normalizationVersion: NORMALIZATION_VERSION }, conflict];
    const before = structuredClone(target);
    expect(() => mergeImportedWorkspace(target, incoming)).toThrow(/редакцию/);
    expect(target).toEqual(before);
  });

  it('retains local verification for an identical existing decision and leaves new imported evidence unverified', () => {
    const target = fixture(); const incoming = checkedImport();
    const originalDecision = structuredClone(target.linkDecisions[0]);
    incoming.linkDecisions.push({ ...incoming.linkDecisions[0], id: 'new-imported-link', practiceId: 'another-card' });
    mergeImportedWorkspace(target, incoming);
    expect(target.linkDecisions[0]).toEqual(originalDecision);
    expect(target.linkDecisions[1]).toMatchObject({ origin: 'imported', status: 'candidate', importedStatus: 'verified', fieldEvidence: [{ reviewStatus: 'candidate' }] });
    expect(validateWorkspaceState(target).linkDecisions).toHaveLength(2);
  });

  it('does not make a stale reviewedValue true by overwriting a differing local custom card', () => {
    const target = fixture();
    target.customCards[0] = { ...target.customCards[0], amount: '200 000 рублей', reviewStatus: 'candidate' };
    const incoming = checkedImport(); incoming.linkDecisions[0].id = 'new-imported-link';
    mergeImportedWorkspace(target, incoming);
    expect(target.customCards[0].amount).toBe('200 000 рублей');
    expect(target.linkDecisions.map(link => link.fieldEvidence[0])).toEqual([
      expect.objectContaining({ reviewedValue: '100 000 рублей', reviewStatus: 'verified' }),
      expect.objectContaining({ reviewedValue: '100 000 рублей', reviewStatus: 'candidate' }),
    ]);
    const evaluation = evaluateFieldEvidence(withLocalEvidence(target.customCards[0], target), 'amount', { versions: [source], occurrences: localOccurrences(target) });
    expect(evaluation.status).toBe('partial');
    expect(evaluation.issues.some(issue => issue.code === 'field_value_not_reviewed')).toBe(true);
  });
});

describe('ZIP/JSON import limits and entry filtering', () => {
  it('imports plain JSON and ordinary stored/deflated ZIPs through the same verification-reset boundary', async () => {
    const state = fixture(); state.profile = { displayName: 'Имя не экспортируется', email: 'example@example.test' };
    for (const input of [file(json(state), 'workspace.json'), file(zip(json(state), 0)), file(zip(json(state)), 'WORKSPACE.ZIP')]) {
      const parsed = await readWorkspaceArchive(input);
      expect(parsed.containsProfile).toBe(false);
      expect(parsed.workspace.annotations[0].anchor).toEqual(state.annotations[0].anchor);
      expect(parsed.workspace.linkDecisions[0]).toMatchObject({ origin: 'imported', status: 'candidate', fieldEvidence: [{ reviewStatus: 'candidate' }] });
      expect(parsed.workspace.customCards[0].reviewStatus).toBe('candidate');
      expect(parsed.verificationResetCount).toBe(3);
    }
  });

  it('accepts a valid streamed ZIP that uses a data descriptor instead of local size/CRC fields', async () => {
    const parsed = await readWorkspaceArchive(file(streamedZip(json())));
    expect(parsed.workspace.annotations).toHaveLength(1);
    expect(parsed.workspace.sourceReferences[0].editionId).toBe(source.id);
  });

  it.each(['nested/workspace.json', '../workspace.json', 'WORKSPACE.JSON'])('does not substitute %s for the exact root entry', async name => {
    await expect(readWorkspaceArchive(file(zipSync({ [name]: strToU8(json()) })))).rejects.toThrow(/отсутствует workspace.json/);
  });

  it('never inflates unrelated entries even when they declare an enormous original size', async () => {
    const archive = declareSize(zipSync({ 'workspace.json': strToU8(json()), '../ignored.bin': strToU8('not a workspace') }), 0x7fffffff, '../ignored.bin');
    const parsed = await readWorkspaceArchive(file(archive));
    expect(parsed.workspace.id).toBe('workbook');
  });

  it('rejects an input above 8 MiB before reading it', async () => {
    const input = file(new Uint8Array(8 * 1024 * 1024 + 1));
    const read = vi.spyOn(input, 'arrayBuffer');
    await expect(readWorkspaceArchive(input)).rejects.toThrow(/8 МиБ/);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects JSON and declared workspace ZIP sizes above 5 MiB', async () => {
    await expect(readWorkspaceArchive(file(new Uint8Array(MAX_EXCHANGE_BYTES + 1), 'workspace.json'))).rejects.toThrow(/5 МиБ/);
    await expect(readWorkspaceArchive(file(declareSize(zip(), MAX_EXCHANGE_BYTES + 1)))).rejects.toThrow(/5 МиБ/);
  });

  it('counts actual DEFLATE output instead of allowing a forged smaller size header', async () => {
    const valid = json();
    const actual = `${valid}${' '.repeat(MAX_EXCHANGE_BYTES + 1 - strToU8(valid).length)}`;
    const archive = declareSize(zip(actual), MAX_EXCHANGE_BYTES);
    expect(archive.length).toBeLessThan(20_000);
    await expect(readWorkspaceArchive(file(archive))).rejects.toThrow(/5 МиБ/);
  });

  it('never truncates an invalid trailing payload into an apparently valid JSON prefix', async () => {
    const valid = json();
    const archive = declareSize(zip(`${valid}INVALID_TRAILER`), strToU8(valid).length);
    await expect(readWorkspaceArchive(file(archive))).rejects.toThrow(/размер.*не совпадает/);
  });

  it('rejects an inflated length shorter than the declared size', async () => {
    const valid = json();
    await expect(readWorkspaceArchive(file(declareSize(zip(valid), strToU8(valid).length + 1)))).rejects.toThrow(/размер.*не совпадает/);
  });

  it('rejects a CRC mismatch even when both local and central headers agree', async () => {
    const archive = zip(); const offsets = entryOffsets(archive, 'workspace.json'); const view = new DataView(archive.buffer);
    const changed = (view.getUint32(offsets.central + 16, true) ^ 1) >>> 0;
    view.setUint32(offsets.central + 16, changed, true); view.setUint32(offsets.local + 14, changed, true);
    await expect(readWorkspaceArchive(file(archive))).rejects.toThrow(/CRC32/);
  });

  it('rejects duplicate workspace entries instead of choosing the last entry', async () => {
    const archive = renameEntry(zipSync({ 'workspace.json': strToU8(json()), 'workspacx.json': strToU8(json()) }), 'workspacx.json', 'workspace.json');
    await expect(readWorkspaceArchive(file(archive))).rejects.toThrow(/несколько записей workspace.json/);
  });

  it.each(['encrypted', 'unsupportedCompression'] as const)('rejects an unsupported workspace encoding (%s) before decoding', async mode => {
    const archive = zip(); const offsets = entryOffsets(archive, 'workspace.json'); const view = new DataView(archive.buffer);
    if (mode === 'encrypted') {
      view.setUint16(offsets.central + 8, view.getUint16(offsets.central + 8, true) | 1, true);
      view.setUint16(offsets.local + 6, view.getUint16(offsets.local + 6, true) | 1, true);
    } else { view.setUint16(offsets.central + 10, 99, true); view.setUint16(offsets.local + 8, 99, true); }
    await expect(readWorkspaceArchive(file(archive))).rejects.toThrow();
  });

  it('rejects truncated ZIPs and invalid UTF-8 rather than importing replacement characters', async () => {
    const archive = zip();
    await expect(readWorkspaceArchive(file(archive.subarray(0, archive.length - 5)))).rejects.toThrow();
    await expect(readWorkspaceArchive(file(new Uint8Array([0xff, 0x7b, 0x7d]), 'workspace.json'))).rejects.toThrow(/UTF-8/);
    await expect(readWorkspaceArchive(file(zipSync({ 'workspace.json': new Uint8Array([0xff, 0x7b, 0x7d]) })))).rejects.toThrow(/UTF-8/);
  });

  it('bounds ZIP metadata entry count and refuses ZIP64/multivolume headers', async () => {
    const files: Record<string, Uint8Array> = { 'workspace.json': strToU8(json()) };
    for (let index = 0; index < 256; index++) files[`extra-${index}.txt`] = new Uint8Array();
    await expect(readWorkspaceArchive(file(zipSync(files)))).rejects.toThrow(/слишком много записей/);
    const zip64 = zip(); const view = new DataView(zip64.buffer); view.setUint16(zip64.length - 22 + 10, 0xffff, true);
    await expect(readWorkspaceArchive(file(zip64))).rejects.toThrow(/ZIP64/);
    const multivolume = zip(); const diskView = new DataView(multivolume.buffer); diskView.setUint16(multivolume.length - 22 + 4, 1, true);
    await expect(readWorkspaceArchive(file(multivolume))).rejects.toThrow(/однодисковый/);
  });
});

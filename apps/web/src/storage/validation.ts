import { NORMALIZATION_VERSIONS, PRACTICE_FIELDS } from '../../../../packages/domain/src/types';
import { WorkspaceError } from './errors';
import { MAX_EXCHANGE_BYTES, WORKSPACE_SCHEMA_VERSION, type WorkspaceState } from './types';

type JsonObject = Record<string, unknown>;
const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor']);
const statuses = ['catalog-only', 'candidate', 'verified', 'contradicted'] as const;

function fail(path: string, message: string): never {
  throw new WorkspaceError('INVALID_DATA', message, path);
}

/** Reject executable/non-JSON values and prototype tricks before field-level validation. */
export function assertSafeJsonTree(value: unknown): void {
  let nodes = 0;
  const visited = new WeakSet<object>();
  const visit = (node: unknown, path: string, depth: number): void => {
    if (++nodes > 250_000 || depth > 24) fail(path, 'Структура файла слишком сложна.');
    if (node === null || typeof node === 'boolean') return;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) fail(path, 'Число должно быть конечным.');
      return;
    }
    if (typeof node === 'string') {
      if (node.length > MAX_EXCHANGE_BYTES) fail(path, 'Текст превышает допустимую длину.');
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(node)) {
        fail(path, 'Недопустимые управляющие символы.');
      }
      for (let i = 0; i < node.length; i++) {
        const c = node.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = node.charCodeAt(++i);
          if (!(next >= 0xdc00 && next <= 0xdfff))
            fail(path, 'Некорректная последовательность Unicode.');
        } else if (c >= 0xdc00 && c <= 0xdfff) {
          fail(path, 'Некорректная последовательность Unicode.');
        }
      }
      return;
    }
    if (typeof node !== 'object') fail(path, 'Допустимы только значения JSON.');
    if (visited.has(node)) fail(path, 'Циклическая или повторная объектная ссылка недопустима.');
    visited.add(node);
    const proto = Object.getPrototypeOf(node);
    if (!Array.isArray(node) && proto !== Object.prototype && proto !== null) {
      fail(path, 'Недопустимый прототип объекта.');
    }
    const descriptors = Object.getOwnPropertyDescriptors(node);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') fail(path, 'Символьные ключи недопустимы.');
      if (Array.isArray(node) && key === 'length') continue;
      if (dangerousKeys.has(key)) fail(`${path}.${key}`, 'Недопустимый ключ объекта.');
      const descriptor = descriptors[key];
      if (!('value' in descriptor) || !descriptor.enumerable)
        fail(path, 'Недопустимое свойство объекта.');
      if (Array.isArray(node) && !/^(0|[1-9]\d*)$/.test(key))
        fail(path, 'Недопустимое свойство массива.');
      visit(descriptor.value, `${path}.${key}`, depth + 1);
    }
    if (Array.isArray(node) && Object.keys(node).length !== node.length)
      fail(path, 'Разреженный массив недопустим.');
    visited.delete(node);
  };
  visit(value, '$', 0);
}

export function object(
  value: unknown,
  path: string,
  required: string[],
  optional: string[] = [],
): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'Ожидался объект.');
  const result = value as JsonObject;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(result))
    if (!allowed.has(key)) fail(`${path}.${key}`, 'Неизвестное поле.');
  for (const key of required)
    if (!Object.hasOwn(result, key)) fail(`${path}.${key}`, 'Обязательное поле отсутствует.');
  return result;
}

function text(value: unknown, path: string, max = 20_000, min = 0): asserts value is string {
  if (typeof value !== 'string' || value.length < min || value.length > max)
    fail(path, 'Недопустимая длина текста.');
}

export function identifier(value: unknown, path: string): asserts value is string {
  text(value, path, 160, 1);
  if (value.trim() !== value || /\s/.test(value) || dangerousKeys.has(value))
    fail(path, 'Некорректный идентификатор.');
}

export function integer(
  value: unknown,
  path: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    fail(path, 'Ожидалось допустимое целое число.');
}

export function timestamp(value: unknown, path: string): asserts value is string {
  text(value, path, 32, 20);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail(path, 'Ожидалась дата ISO 8601 в UTC.');
  }
  // Date.parse normalizes impossible day numbers in some engines. Reject those as well.
  if (new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19))
    fail(path, 'Несуществующая дата.');
}

function choice(value: unknown, path: string, options: readonly string[]): void {
  if (typeof value !== 'string' || !options.includes(value)) fail(path, 'Неизвестное значение.');
}

function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(path, 'Недопустимый массив.');
  return value;
}

function ids(value: unknown, path: string, max = 5_000): string[] {
  const result = array(value, path, max);
  result.forEach((item, i) => identifier(item, `${path}[${i}]`));
  if (new Set(result).size !== result.length) fail(path, 'Повторяющиеся идентификаторы.');
  return result as string[];
}

function entityRows(value: unknown, path: string, max: number): JsonObject[] {
  const rows = array(value, path, max);
  const seen = new Set<unknown>();
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      fail(`${path}[${index}]`, 'Ожидалась запись.');
    const id = (row as JsonObject).id;
    identifier(id, `${path}[${index}].id`);
    if (seen.has(id)) fail(path, 'Повторяющийся идентификатор записи.');
    seen.add(id);
  });
  return rows as JsonObject[];
}

function datePair(record: JsonObject, path: string): void {
  timestamp(record.createdAt, `${path}.createdAt`);
  timestamp(record.updatedAt, `${path}.updatedAt`);
  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt))
    fail(path, 'Обновление не может предшествовать созданию.');
}

/** Returns an independently owned validated copy; it never mutates the caller's object. */
export function validateWorkspaceState(value: unknown): WorkspaceState {
  assertSafeJsonTree(value);
  const state = object(value, '$', [
    'schemaVersion',
    'id',
    'title',
    'profile',
    'sourceReferences',
    'annotations',
    'practiceProposals',
    'linkDecisions',
    'customCards',
    'readingTasks',
    'preferences',
  ]);
  if (state.schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    throw new WorkspaceError(
      'UNSUPPORTED_VERSION',
      'Версия рабочей тетради не поддерживается.',
      '$.schemaVersion',
    );
  }
  identifier(state.id, '$.id');
  text(state.title, '$.title', 300, 1);
  if (state.profile !== null) {
    const profile = object(state.profile, '$.profile', ['displayName'], ['email']);
    text(profile.displayName, '$.profile.displayName', 200, 1);
    if (Object.hasOwn(profile, 'email')) {
      text(profile.email, '$.profile.email', 254, 3);
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(profile.email))
        fail('$.profile.email', 'Некорректный email.');
    }
  }
  const editions = new Map<string, { sourceId: string; normalizationVersion: string }>();
  array(state.sourceReferences, '$.sourceReferences', 5_000).forEach((row, i) => {
    const p = `$.sourceReferences[${i}]`;
    const ref = object(
      row,
      p,
      ['sourceId', 'editionId', 'title', 'normalizationVersion'],
      ['sha256', 'sourceUrl', 'regionId'],
    );
    identifier(ref.sourceId, `${p}.sourceId`);
    identifier(ref.editionId, `${p}.editionId`);
    if (editions.has(ref.editionId)) fail(p, 'Редакция источника указана повторно.');
    editions.set(ref.editionId, {
      sourceId: ref.sourceId,
      normalizationVersion: ref.normalizationVersion as string,
    });
    text(ref.title, `${p}.title`, 1_000, 1);
    if (Object.hasOwn(ref, 'sha256')) {
      text(ref.sha256, `${p}.sha256`, 64, 64);
      if (!/^[a-f0-9]{64}$/.test(ref.sha256))
        fail(`${p}.sha256`, 'Ожидался SHA-256 в нижнем регистре.');
    }
    text(ref.normalizationVersion, `${p}.normalizationVersion`, 100, 1);
    if (Object.hasOwn(ref, 'regionId')) identifier(ref.regionId, `${p}.regionId`);
    if (Object.hasOwn(ref, 'sourceUrl')) {
      text(ref.sourceUrl, `${p}.sourceUrl`, 2_000, 1);
      try {
        const url = new URL(ref.sourceUrl);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
          fail(`${p}.sourceUrl`, 'Разрешены только HTTP(S)-адреса без учётных данных.');
      } catch (error) {
        if (error instanceof WorkspaceError) throw error;
        fail(`${p}.sourceUrl`, 'Некорректный адрес источника.');
      }
    }
  });
  const annotations = new Map<string, { sourceEditionId: string }>();
  entityRows(state.annotations, '$.annotations', 5_000).forEach((row, i) => {
    const p = `$.annotations[${i}]`;
    const annotation = object(row, p, ['id', 'anchor', 'note', 'createdAt', 'updatedAt']);
    const anchor = object(annotation.anchor, `${p}.anchor`, [
      'id',
      'documentId',
      'versionId',
      'normalizationVersion',
      'spans',
    ]);
    for (const key of ['id', 'documentId', 'versionId'])
      identifier(anchor[key], `${p}.anchor.${key}`);
    if (
      typeof anchor.normalizationVersion !== 'string' ||
      !NORMALIZATION_VERSIONS.includes(anchor.normalizationVersion)
    )
      fail(p, 'Неподдерживаемая версия нормализации текста.');
    const edition = editions.get(anchor.versionId as string);
    if (
      !edition ||
      edition.sourceId !== anchor.documentId ||
      edition.normalizationVersion !== anchor.normalizationVersion
    ) {
      fail(p, 'Редакция и документ выделения не соответствуют описанию источника.');
    }
    const spans = array(anchor.spans, `${p}.anchor.spans`, 256);
    if (spans.length === 0) fail(p, 'Выделение должно содержать фрагмент.');
    const selectedBlocks = new Set<string>();
    spans.forEach((item, j) => {
      const sp = `${p}.anchor.spans[${j}]`;
      const span = object(item, sp, ['blockId', 'start', 'end', 'exact', 'prefix', 'suffix']);
      identifier(span.blockId, `${sp}.blockId`);
      if (selectedBlocks.has(span.blockId)) fail(sp, 'Один блок указан в выделении несколько раз.');
      selectedBlocks.add(span.blockId);
      text(span.exact, `${sp}.exact`, 20_000, 1);
      text(span.prefix, `${sp}.prefix`, 500);
      text(span.suffix, `${sp}.suffix`, 500);
      integer(span.start, `${sp}.start`, 0, 10_000_000);
      integer(span.end, `${sp}.end`, 1, 10_000_000);
      if (span.end <= span.start || span.end - span.start !== Array.from(span.exact).length) {
        fail(sp, 'Длина точной цитаты не соответствует диапазону кодовых точек.');
      }
    });
    text(annotation.note, `${p}.note`);
    datePair(annotation, p);
    annotations.set(annotation.id as string, { sourceEditionId: anchor.versionId as string });
  });
  const checkEvidence = (value: unknown, p: string): void => {
    array(value, p, 5_000).forEach((item, index) => {
      const ep = `${p}[${index}]`;
      if (!item || typeof item !== 'object' || Array.isArray(item))
        fail(ep, 'Ожидалось описание доказательства.');
      const kind = (item as JsonObject).kind;
      if (kind === 'fragment') {
        const evidence = object(
          item,
          ep,
          ['kind', 'field', 'occurrenceId', 'relation', 'reviewStatus'],
          ['reviewedValue', 'note'],
        );
        choice(evidence.field, `${ep}.field`, PRACTICE_FIELDS);
        identifier(evidence.occurrenceId, `${ep}.occurrenceId`);
        if (!annotations.has(evidence.occurrenceId))
          fail(ep, 'Не найдено точное выделение для доказательства поля.');
        choice(evidence.relation, `${ep}.relation`, ['supports', 'partial', 'contradicts']);
        choice(evidence.reviewStatus, `${ep}.reviewStatus`, ['candidate', 'verified', 'rejected']);
        if (Object.hasOwn(evidence, 'reviewedValue'))
          text(evidence.reviewedValue, `${ep}.reviewedValue`, 20_000);
        if (evidence.reviewStatus === 'verified' && !Object.hasOwn(evidence, 'reviewedValue'))
          fail(ep, 'Проверка поля должна фиксировать проверенное значение.');
        if (Object.hasOwn(evidence, 'note')) text(evidence.note, `${ep}.note`);
      } else if (kind === 'document') {
        const evidence = object(item, ep, ['kind', 'documentId', 'versionId'], ['field', 'note']);
        identifier(evidence.documentId, `${ep}.documentId`);
        identifier(evidence.versionId, `${ep}.versionId`);
        const edition = editions.get(evidence.versionId);
        if (!edition || edition.sourceId !== evidence.documentId)
          fail(ep, 'Не найдена указанная редакция документа.');
        if (Object.hasOwn(evidence, 'field'))
          choice(evidence.field, `${ep}.field`, PRACTICE_FIELDS);
        if (Object.hasOwn(evidence, 'note')) text(evidence.note, `${ep}.note`);
      } else if (kind === 'article') {
        const evidence = object(item, ep, ['kind', 'url'], ['field', 'title', 'note']);
        text(evidence.url, `${ep}.url`, 2_000, 1);
        let url: URL;
        try {
          url = new URL(evidence.url);
        } catch {
          fail(ep, 'Некорректный адрес публикации.');
        }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          fail(ep, 'Недопустимый адрес публикации.');
        if (Object.hasOwn(evidence, 'field'))
          choice(evidence.field, `${ep}.field`, PRACTICE_FIELDS);
        if (Object.hasOwn(evidence, 'title')) text(evidence.title, `${ep}.title`, 1_000);
        if (Object.hasOwn(evidence, 'note')) text(evidence.note, `${ep}.note`);
      } else fail(ep, 'Неизвестный тип доказательства.');
    });
  };
  const checkAnnotations = (record: JsonObject, p: string): string[] => {
    const links = ids(record.annotationIds, `${p}.annotationIds`);
    for (const id of links)
      if (!annotations.has(id)) fail(`${p}.annotationIds`, 'Не найдено связанное выделение.');
    return links;
  };
  entityRows(state.practiceProposals, '$.practiceProposals', 2_000).forEach((row, i) => {
    const p = `$.practiceProposals[${i}]`;
    const proposal = object(
      row,
      p,
      ['id', 'title', 'summary', 'annotationIds', 'createdAt', 'updatedAt'],
      ['catalogPracticeId'],
    );
    text(proposal.title, `${p}.title`, 500, 1);
    text(proposal.summary, `${p}.summary`);
    if (checkAnnotations(proposal, p).length === 0)
      fail(p, 'Предложение практики должно ссылаться хотя бы на одно выделение.');
    if (Object.hasOwn(proposal, 'catalogPracticeId'))
      identifier(proposal.catalogPracticeId, `${p}.catalogPracticeId`);
    datePair(proposal, p);
  });
  entityRows(state.linkDecisions, '$.linkDecisions', 5_000).forEach((row, i) => {
    const p = `$.linkDecisions[${i}]`;
    const decision = object(
      row,
      p,
      [
        'id',
        'annotationId',
        'practiceId',
        'status',
        'rationale',
        'decidedAt',
        'origin',
        'fieldEvidence',
      ],
      ['importedStatus'],
    );
    identifier(decision.practiceId, `${p}.practiceId`);
    choice(decision.status, `${p}.status`, statuses);
    if (decision.annotationId !== null) {
      identifier(decision.annotationId, `${p}.annotationId`);
      if (!annotations.has(decision.annotationId)) fail(p, 'Не найдено выделение для связи.');
    } else if (decision.status !== 'catalog-only')
      fail(p, 'Сопоставление требует точного выделения.');
    text(decision.rationale, `${p}.rationale`, 20_000, decision.status === 'contradicted' ? 5 : 0);
    timestamp(decision.decidedAt, `${p}.decidedAt`);
    checkEvidence(decision.fieldEvidence, `${p}.fieldEvidence`);
    if (decision.status === 'contradicted' && (decision.rationale as string).trim().length < 5)
      fail(p, 'Для противоречия требуется содержательное обоснование.');
    if (
      decision.status === 'verified' &&
      !(decision.rationale as string).trim() &&
      !(decision.fieldEvidence as JsonObject[]).some(
        (e) =>
          e.kind === 'fragment' &&
          e.reviewStatus === 'verified' &&
          e.relation === 'supports' &&
          typeof e.reviewedValue === 'string' &&
          e.reviewedValue.trim().length > 0,
      )
    ) {
      fail(
        p,
        'Подтверждённая связь без комментария требует проверенного основания конкретного поля.',
      );
    }
    choice(decision.origin, `${p}.origin`, ['local', 'imported']);
    if (Object.hasOwn(decision, 'importedStatus'))
      choice(decision.importedStatus, `${p}.importedStatus`, statuses);
    if (
      decision.origin === 'imported' &&
      (decision.status === 'verified' ||
        (decision.fieldEvidence as JsonObject[]).some(
          (e) => e.kind === 'fragment' && e.reviewStatus === 'verified',
        ))
    )
      fail(p, 'Импортированная связь требует локальной проверки.');
  });
  entityRows(state.customCards, '$.customCards', 2_000).forEach((row, i) => {
    const p = `$.customCards[${i}]`;
    const card = object(
      row,
      p,
      [
        'id',
        'familyId',
        'regionId',
        'title',
        'mechanism',
        'occurrenceIds',
        'createdAt',
        'updatedAt',
      ],
      ['eligibility', 'amount', 'conditions', 'evidence', 'reviewStatus'],
    );
    identifier(card.familyId, `${p}.familyId`);
    identifier(card.regionId, `${p}.regionId`);
    text(card.title, `${p}.title`, 500, 1);
    text(card.mechanism, `${p}.mechanism`);
    for (const key of ['eligibility', 'amount'])
      if (Object.hasOwn(card, key) && card[key] !== null) text(card[key], `${p}.${key}`);
    if (Object.hasOwn(card, 'conditions'))
      array(card.conditions, `${p}.conditions`, 500).forEach((condition, j) =>
        text(condition, `${p}.conditions[${j}]`, 5_000),
      );
    for (const id of ids(card.occurrenceIds, `${p}.occurrenceIds`))
      if (!annotations.has(id)) fail(p, 'Не найдено точное выделение карточки.');
    if (Object.hasOwn(card, 'evidence')) checkEvidence(card.evidence, `${p}.evidence`);
    if (Object.hasOwn(card, 'reviewStatus'))
      choice(card.reviewStatus, `${p}.reviewStatus`, ['candidate', 'verified', 'rejected']);
    datePair(card, p);
  });
  entityRows(state.readingTasks, '$.readingTasks', 5_000).forEach((row, i) => {
    const p = `$.readingTasks[${i}]`;
    const task = object(row, p, [
      'id',
      'sourceEditionId',
      'status',
      'reviewedBlockIds',
      'annotationIds',
      'note',
      'updatedAt',
    ]);
    identifier(task.sourceEditionId, `${p}.sourceEditionId`);
    if (!editions.has(task.sourceEditionId)) fail(p, 'Не найдена редакция источника задания.');
    choice(task.status, `${p}.status`, ['not-started', 'in-progress', 'fragment-reviewed']);
    const blocks = ids(task.reviewedBlockIds, `${p}.reviewedBlockIds`);
    const links = checkAnnotations(task, p);
    if (task.status === 'fragment-reviewed' && blocks.length + links.length === 0)
      fail(p, 'Нужно указать проверенный фрагмент.');
    for (const id of links)
      if (annotations.get(id)?.sourceEditionId !== task.sourceEditionId)
        fail(p, 'Выделение относится к другой редакции документа.');
    text(task.note, `${p}.note`);
    timestamp(task.updatedAt, `${p}.updatedAt`);
  });
  const prefs = object(state.preferences, '$.preferences', [
    'selectedRegionId',
    'selectedSourceEditionId',
    'selectedPracticeId',
    'activePanel',
    'readerFontScale',
  ]);
  for (const key of ['selectedRegionId', 'selectedSourceEditionId', 'selectedPracticeId'])
    if (prefs[key] !== null) identifier(prefs[key], `$.preferences.${key}`);
  choice(prefs.activePanel, '$.preferences.activePanel', [
    'documents',
    'practice-catalog',
    'my-work',
  ]);
  if (
    typeof prefs.readerFontScale !== 'number' ||
    prefs.readerFontScale < 0.75 ||
    prefs.readerFontScale > 2
  )
    fail('$.preferences.readerFontScale', 'Размер текста должен быть от 0,75 до 2.');
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > MAX_EXCHANGE_BYTES)
    throw new WorkspaceError(
      'FILE_TOO_LARGE',
      'Рабочая тетрадь превышает допустимый размер 5 МиБ.',
    );
  return JSON.parse(serialized) as WorkspaceState;
}

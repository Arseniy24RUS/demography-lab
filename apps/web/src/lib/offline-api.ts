import type { Session } from '@supabase/supabase-js';
import { randomSecret } from '../../../../packages/security/crypto.mjs';
import type { CloudConfig } from './cloud-config';

export interface LocalRegistration {
  email: string;
  fullName: string;
  joinCode: string;
  recoverySecret: string;
}
export interface LocalAccessReceipt {
  format: 'demography-local-access-1';
  instanceId: string;
  recoverySecret: string;
  serverUrl: string;
}
export interface PendingLocalRegistration {
  format: 'demography-local-registration-1';
  fingerprint: string;
  identity: { email: string; fullName: string };
  receipt: LocalAccessReceipt;
}
export interface LocalServerStatus {
  instanceId: string;
  joinCode: string;
  port: number;
  surveyPort: number;
  counts: Record<string, number>;
  lastBackup: null | { createdAt: string; path: string; bytes: number };
  lanHosts: string[];
  queueDepth: number;
}

const localErrors: Record<string, string> = {
  INVALID_JOIN_CODE: 'Код локальной сети не подошёл. Проверьте его на экране преподавателя.',
  INVALID_CLASSROOM_CODE: 'Код локальной сети не подошёл. Проверьте его на экране преподавателя.',
  INVALID_INPUT: 'Проверьте имя, email и код локальной сети.',
  INVALID_RECOVERY: 'Ключ доступа не найден на этом Mac. Проверьте квитанцию и адрес семинара.',
  INVALID_RECOVERY_SECRET: 'Ключ доступа не подошёл. Загрузите личную квитанцию или скопируйте ключ целиком.',
  RECOVERY_NOT_FOUND: 'Ключ доступа не найден на этом Mac. Проверьте квитанцию и адрес семинара.',
  FORBIDDEN: 'Это действие доступно преподавателю в браузере на Mac, где запущен сервер.',
  HOST_LOCAL_ONLY: 'Это действие доступно непосредственно на Mac преподавателя. Откройте локальный адрес 127.0.0.1.',
  AUTH_REQUIRED: 'Войдите повторно, используя сохранённый ключ доступа.',
  TOKEN_EXPIRED_OR_REVOKED: 'Срок этого входа истёк. Используйте сохранённый личный ключ доступа.',
  RATE_LIMITED: 'Слишком много попыток. Подождите и повторите ввод.',
};

export async function offlineRequest<T>(
  config: CloudConfig,
  path: string,
  body?: unknown,
  accessToken?: string,
): Promise<T> {
  if (!config.offline || config.url !== location.origin || !path.startsWith('/offline/'))
    throw new Error('Локальный сервер не настроен для этого адреса.');
  let response: Response;
  try {
    response = await fetch(`${config.url}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(path.endsWith('/backup') ? 120000 : 30000),
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(path.endsWith('/host-bootstrap') ? { 'X-Offline-Host-Bootstrap': '1' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Error('Mac не ответил. Подключитесь к сети семинара и повторите действие.');
  }
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new Error('Локальный сервер вернул неожиданный ответ. Обновите страницу.'); }
  if (!response.ok) {
    const value = data as { error?: string | { code?: string }; code?: string; message?: string };
    const code = typeof value.error === 'string' ? value.error : value.error?.code ?? value.code ?? value.message ?? '';
    throw new Error(localErrors[code] ?? (response.status === 429 ? localErrors.RATE_LIMITED :
      'Локальный сервер не принял действие. Проверьте данные и повторите попытку.'));
  }
  return data as T;
}

export async function localLogin(config: CloudConfig, input: LocalRegistration) {
  const result = await offlineRequest<{ session: Session }>(config, '/offline/auth/register', input);
  // Activate after server acknowledgement, before setSession can unmount the access form.
  // A rejected request leaves both the existing account key and the pending retry intact.
  const fingerprint = registrationFingerprint(input);
  const pending = readPendingRegistration(config.offlineInstanceId!, fingerprint);
  const receipt = pending?.receipt.recoverySecret === input.recoverySecret ? pending.receipt : {
    format: 'demography-local-access-1' as const, instanceId: config.offlineInstanceId!,
    serverUrl: config.url, recoverySecret: input.recoverySecret,
  };
  if (keepLocalReceipt(receipt)) clearPendingRegistration(receipt.instanceId, fingerprint);
  return result;
}
export async function localRecovery(config: CloudConfig, recoverySecret: string) {
  const result = await offlineRequest<{ session: Session }>(config, '/offline/auth/recover', { recoverySecret });
  keepLocalReceipt({ format: 'demography-local-access-1', instanceId: config.offlineInstanceId!,
    serverUrl: config.url, recoverySecret });
  return result;
}
export const localHost = (config: CloudConfig) =>
  offlineRequest<{ session: Session }>(config, '/offline/auth/host-bootstrap', {});

const receiptKey = (instanceId: string) => `dw-local-access-v1:${instanceId}`;
const pendingPrefix = (instanceId: string) => `dw-local-access-pending-v1:${instanceId}:`;
const pendingKey = (instanceId: string, fingerprint: string) => pendingPrefix(instanceId) + encodeURIComponent(fingerprint);
const pendingPointer = (instanceId: string) => `dw-local-access-pending-current-v1:${instanceId}`;
const memoryReceipts = new Map<string, { receipt: LocalAccessReceipt; persisted: boolean }>();
const memoryPending = new Map<string, PendingLocalRegistration>();
const memoryLatest = new Map<string, string>();
const validReceipt = (value: unknown, instanceId: string): value is LocalAccessReceipt => {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<LocalAccessReceipt>;
  return row.format === 'demography-local-access-1' && row.instanceId === instanceId &&
    typeof row.serverUrl === 'string' && typeof row.recoverySecret === 'string' && /^[a-f\d]{64}$/u.test(row.recoverySecret);
};

/** The classroom code is authorization, not identity: correcting it reuses the same attempt. */
export function registrationFingerprint(input: Pick<LocalRegistration, 'email' | 'fullName'>): string {
  return JSON.stringify([input.email.trim().toLowerCase(), input.fullName.trim()]);
}
export function readPendingRegistration(instanceId: string, fingerprint?: string): PendingLocalRegistration | null {
  let selected = fingerprint ?? memoryLatest.get(instanceId);
  try { selected ??= localStorage.getItem(pendingPointer(instanceId)) ?? undefined; } catch { /* In-memory retry remains available. */ }
  if (!selected || selected.length > 1200) return null;
  const key = pendingKey(instanceId, selected);
  let value: unknown = memoryPending.get(key);
  if (!value) {
    try { const stored = localStorage.getItem(key); if (stored) value = JSON.parse(stored); }
    catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  const pending = value as PendingLocalRegistration;
  if (pending.format !== 'demography-local-registration-1' || pending.fingerprint !== selected ||
    !pending.identity || typeof pending.identity.email !== 'string' || typeof pending.identity.fullName !== 'string' ||
    registrationFingerprint(pending.identity) !== selected || !validReceipt(pending.receipt, instanceId)) return null;
  return pending;
}
export function beginLocalRegistration(instanceId: string, serverUrl: string,
  input: Pick<LocalRegistration, 'email' | 'fullName'>): { pending: PendingLocalRegistration; persisted: boolean } {
  const fingerprint = registrationFingerprint(input);
  const pending = readPendingRegistration(instanceId, fingerprint) ?? {
    format: 'demography-local-registration-1' as const, fingerprint,
    identity: { email: input.email.trim().toLowerCase(), fullName: input.fullName.trim() },
    receipt: newLocalReceipt(instanceId, serverUrl),
  };
  const key = pendingKey(instanceId, fingerprint);
  memoryPending.set(key, pending); memoryLatest.set(instanceId, fingerprint);
  let persisted = false;
  try {
    localStorage.setItem(key, JSON.stringify(pending));
    persisted = true;
    localStorage.setItem(pendingPointer(instanceId), fingerprint);
  } catch { /* A download before POST is required if durable storage failed. */ }
  return { pending, persisted };
}
export function clearPendingRegistration(instanceId: string, fingerprint: string) {
  const key = pendingKey(instanceId, fingerprint);
  memoryPending.delete(key);
  if (memoryLatest.get(instanceId) === fingerprint) memoryLatest.delete(instanceId);
  try {
    localStorage.removeItem(key);
    if (localStorage.getItem(pendingPointer(instanceId)) === fingerprint) localStorage.removeItem(pendingPointer(instanceId));
  } catch { /* A retained durable draft is safe and continues to identify the same account. */ }
}
export function readLocalReceipt(instanceId: string): LocalAccessReceipt | null {
  const memory = memoryReceipts.get(instanceId);
  if (memory && !memory.persisted) return memory.receipt;
  try {
    const text = localStorage.getItem(receiptKey(instanceId));
    if (!text) return null;
    const row: unknown = JSON.parse(text);
    return validReceipt(row, instanceId) ? row : null;
  } catch { return memory?.receipt ?? null; }
}
export function keepLocalReceipt(receipt: LocalAccessReceipt): boolean {
  if (!validReceipt(receipt, receipt.instanceId)) throw new Error('Некорректная квитанция доступа.');
  const entry = { receipt, persisted: false };
  memoryReceipts.set(receipt.instanceId, entry);
  try { localStorage.setItem(receiptKey(receipt.instanceId), JSON.stringify(receipt)); entry.persisted = true; }
  catch { /* Keep a download available after the access form unmounts. */ }
  return entry.persisted;
}
export function forgetLocalReceipt(instanceId: string) {
  memoryReceipts.delete(instanceId); memoryLatest.delete(instanceId);
  for (const key of memoryPending.keys()) if (key.startsWith(pendingPrefix(instanceId))) memoryPending.delete(key);
  try {
    localStorage.removeItem(receiptKey(instanceId)); localStorage.removeItem(pendingPointer(instanceId));
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    for (const key of keys) if (key?.startsWith(pendingPrefix(instanceId))) localStorage.removeItem(key);
  } catch { /* Storage may be disabled. */ }
}
export function newLocalReceipt(instanceId: string, serverUrl: string): LocalAccessReceipt {
  return { format: 'demography-local-access-1', instanceId, serverUrl, recoverySecret: randomSecret() };
}
export function downloadLocalReceipt(receipt: LocalAccessReceipt) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'Demography_Lab_Access.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

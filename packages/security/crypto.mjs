import { sha256 } from '@noble/hashes/sha2.js';

/** Identical SHA-256 on HTTPS, localhost and classroom HTTP LAN addresses.
 * No global Web Crypto polyfill: call sites explicitly choose this implementation.
 */
export async function sha256Hex(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const digest = globalThis.crypto?.subtle
    ? new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
    : sha256(bytes);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** getRandomValues remains available on HTTP LAN; never substitute Math.random. */
export function secureBytes(length) {
  if (!Number.isInteger(length) || length < 1 || length > 65536)
    throw new Error('Некорректный размер случайного ключа.');
  if (!globalThis.crypto?.getRandomValues)
    throw new Error('Браузер не предоставляет безопасный генератор случайных чисел.');
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export function randomSecret() {
  return Array.from(secureBytes(32), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = secureBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

import { NORMALIZATION_VERSION } from './types';

export { NORMALIZATION_VERSION };

export function normalizeCanonicalText(text: string): string {
  return text.replace(/\r\n?/g, '\n').normalize('NFC');
}

export function codePointLength(text: string): number {
  return Array.from(text).length;
}

function assertOffset(offset: number, max: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > max) {
    throw new RangeError(`Offset must be a safe integer in [0, ${max}].`);
  }
}

export function sliceCodePoints(text: string, start: number, end = codePointLength(text)): string {
  const chars = Array.from(text);
  assertOffset(start, chars.length);
  assertOffset(end, chars.length);
  if (end < start) throw new RangeError('End precedes start.');
  return chars.slice(start, end).join('');
}

export function codePointToUtf16Offset(text: string, offset: number): number {
  const chars = Array.from(text);
  assertOffset(offset, chars.length);
  return chars.slice(0, offset).join('').length;
}

export function utf16ToCodePointOffset(text: string, offset: number): number {
  assertOffset(offset, text.length);
  if (offset > 0 && offset < text.length) {
    const left = text.charCodeAt(offset - 1);
    const right = text.charCodeAt(offset);
    if (left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff) {
      throw new RangeError('UTF-16 offset splits a surrogate pair.');
    }
  }
  return codePointLength(text.slice(0, offset));
}

/** Non-cryptographic, deterministic UI/entity IDs. Never use for source integrity. */
export function stableId(
  namespace: string,
  ...parts: readonly (string | number | boolean | null)[]
): string {
  if (!/^[a-z][a-z0-9_-]*$/i.test(namespace)) throw new TypeError('Invalid identifier namespace.');
  const input = JSON.stringify(parts);
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    left = Math.imul(left ^ c, 0x01000193);
    right = Math.imul(right ^ c, 0x85ebca6b);
    right ^= right >>> 13;
  }
  return `${namespace}_${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
}

export function createBlockId(versionId: string, order: number, canonicalText: string): string {
  if (!versionId || !Number.isSafeInteger(order) || order < 0)
    throw new TypeError('Invalid block identity.');
  if (canonicalText !== normalizeCanonicalText(canonicalText))
    throw new TypeError('Block text is not canonical.');
  return stableId('block', versionId, order, canonicalText);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function hasUnpairedSurrogate(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

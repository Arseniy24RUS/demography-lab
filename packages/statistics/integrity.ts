import type { TeamStatisticalSeries } from './types';

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, ordered(nested)]),
    );
  return value;
}

/** Compare material independently of key order, but hash the exact original UTF-8 bytes. */
export async function verifyTeamStatisticalSeries(series: TeamStatisticalSeries): Promise<void> {
  const { canonicalJson, fingerprint, ...material } = series;
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalJson);
  } catch {
    throw new Error('Каноническая редакция статистики содержит некорректный JSON.');
  }
  if (JSON.stringify(ordered(parsed)) !== JSON.stringify(ordered(material)))
    throw new Error('Статистический ряд не соответствует каноническому материалу своей редакции.');
  if (!globalThis.crypto?.subtle)
    throw new Error('Проверка статистической редакции требует HTTPS или localhost с Web Crypto.');
  const bytes = new TextEncoder().encode(canonicalJson);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  const hash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== fingerprint)
    throw new Error(
      'Контрольная сумма статистической редакции не совпадает. Загрузите данные повторно.',
    );
}

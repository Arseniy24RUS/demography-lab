import { sha256Hex } from '../../../../packages/security/crypto.mjs';
import { validSurveyId, validSurveySecret } from './survey-deployment';

export function newSurveySecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
export async function invitationDigest(token: string): Promise<string> {
  if (!validSurveySecret(token)) throw new Error('Некорректный ключ приглашения.');
  return sha256Hex(new TextEncoder().encode('dw-survey-invite:' + token));
}
export function responseStorageKey(apiUrl: string, surveyId: string) {
  return `dw-survey-response-v1:${new URL(apiUrl).origin}:${surveyId}`;
}
export function hostInvitationStorageKey(apiUrl: string, userId: string, sessionId: string) {
  return `dw-survey-invitation-v1:${new URL(apiUrl).origin}:${userId}:${sessionId}`;
}
/** Only bearer secrets are kept here. Answers and consent fields never enter browser persistence. */
export function readSecret(storage: Pick<Storage, 'getItem'>, key: string): string | null {
  try {
    const value = storage.getItem(key);
    return value && validSurveySecret(value) ? value : null;
  } catch {
    return null;
  }
}
export function keepSecret(
  storage: Pick<Storage, 'setItem'>,
  key: string,
  secret: string,
): boolean {
  if (!validSurveySecret(secret)) throw new Error('Некорректный личный ключ.');
  try {
    storage.setItem(key, secret);
    return true;
  } catch {
    return false;
  }
}
export interface SurveyReceipt {
  format: 'demography-survey-receipt-1';
  surveyId: string;
  responseSecret: string;
  surveyUrl: string;
}
export function createSurveyReceipt(
  surveyId: string,
  responseSecret: string,
  surveyUrl: string,
): SurveyReceipt {
  if (!validSurveyId(surveyId) || !validSurveySecret(responseSecret))
    throw new Error('Некорректная квитанция опроса.');
  const url = new URL(surveyUrl);
  url.hash = '';
  url.search = '';
  return { format: 'demography-survey-receipt-1', surveyId, responseSecret, surveyUrl: url.href };
}

/** A readable personal note; the response secret is deliberately absent from its URL. */
export function surveyReceiptText(receipt: SurveyReceipt): string {
  return [
    'Демографическая мастерская — мой ответ на опрос',
    '',
    'Страница ответа:',
    `${receipt.surveyUrl}#survey=${receipt.surveyId}`,
    '',
    'Личный ключ:',
    receipt.responseSecret,
    '',
    'Чтобы посмотреть или удалить ответ с другого устройства, откройте страницу выше,',
    'раскройте «Управление моим ответом» и выберите восстановление по личному ключу.',
    'Храните эту памятку у себя. Ключ не следует передавать преподавателю или другим участникам.',
    '',
  ].join('\n');
}

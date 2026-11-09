import { randomUuid } from '../../../../packages/security/crypto.mjs';
import {
  parseSurveyOwnResponse,
  parseSurveyPublicManifest,
  surveyResponseInputSchema,
} from '../../../../packages/barriers/schema';
import type { SurveyResponseInput } from '../../../../packages/barriers/types';
import { validSurveyId, validSurveySecret } from './survey-deployment';

const messages: Record<string, string> = {
  SURVEY_ANON_ONLY:
    'Форма должна отправляться без учебной учётной записи. Откройте отдельную ссылку опроса.',
  SURVEY_INVITATION_INVALID:
    'Приглашение заменено или недоступно. Личный ключ позволяет проверить или отозвать ранее отправленный ответ.',
  SURVEY_NOT_OPEN:
    'Приём ответов сейчас закрыт. Отзыв ранее отправленного ответа остаётся доступен.',
  SURVEY_LIMIT: 'Достигнут предел количества ответов в этом опросе.',
  SURVEY_CONSENT_REQUIRED:
    'Подтвердите совершеннолетие и добровольное учебное участие. Цитирование требует отдельного согласия на исследование.',
  SURVEY_BRANCH_INVALID:
    'Ответы не соответствуют выбранной перспективе. Проверьте личные намерения и описание условий.',
  SURVEY_CONDITION_CHANGED:
    'Приоритетное условие изменилось. Дайте условную оценку заново для новой формулировки.',
  QUESTION_VERSION_CONFLICT: 'Формулировки анкеты изменились. Обновите страницу до отправки.',
  SESSION_NOT_OPEN:
    'Преподаватель приостановил занятие. Отзыв ранее отправленного ответа остаётся доступен.',
  FORBIDDEN:
    'Форма должна отправляться без учебной учётной записи. Откройте отдельную ссылку опроса.',
  INVALID_INVITATION:
    'Приглашение заменено или недоступно. Личный ключ по-прежнему позволяет отозвать ранее отправленный ответ.',
  NOT_FOUND: 'Опрос или ответ не найден. Проверьте ссылку и личный ключ.',
  SURVEY_CLOSED: 'Приём ответов завершён. Ранее отправленный ответ можно отозвать личным ключом.',
  SURVEY_EXPIRED: 'Срок хранения истёк. Чтение и выгрузка содержимого отключены.',
  SURVEY_PURGED: 'Содержимое опроса удалено организатором.',
  RESPONSE_WITHDRAWN: 'Ответ отозван. Повтор прежней отправки не восстанавливает его.',
  REVISION_CONFLICT:
    'Ответ изменён в другом окне. Сохраните свой текст, затем обновите серверную версию.',
  INVALID_INPUT:
    'Проверьте поля, возраст и согласия. Оценка условия относится только к его текущей формулировке.',
  LIMIT_EXCEEDED: 'Достигнут предел объёма анкеты или количества ответов.',
  RATE_LIMITED: 'Слишком много запросов. Повторите попытку позднее.',
  IDEMPOTENCY_CONFLICT: 'Данные операции изменились. Обновите свой ответ и повторите действие.',
};
export class SurveyApiError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? messages[code] ?? 'Сервер не смог обработать ответ. Текст остался в форме.');
    this.name = 'SurveyApiError';
  }
}
/** No Auth client, account storage, user bearer, cookies or referrer in this transport. */
export class SurveyApi {
  private receipts = new Map<string, { fingerprint: string; id: string }>();
  constructor(
    readonly config: { url: string; publishableKey: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  private async rpc<T>(
    name: string,
    args: Record<string, unknown>,
    parse: (value: unknown) => T,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      // Native Window.fetch must not receive this adapter instance as its receiver.
      const send = this.fetchImpl;
      const response = await send(`${this.config.url}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: { apikey: this.config.publishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: controller.signal,
      });
      const body: unknown = await response.json();
      if (!response.ok || (body && typeof body === 'object' && 'error' in body)) {
        const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
        const error =
          record.error && typeof record.error === 'object'
            ? (record.error as Record<string, unknown>)
            : record;
        const code =
          typeof error.message === 'string'
            ? Object.keys(messages).find(
                (candidate) =>
                  error.message === candidate || String(error.message).startsWith(candidate + ':'),
              )
            : typeof error.code === 'string'
              ? error.code
              : undefined;
        throw new SurveyApiError(
          code ?? (error.code === 'PGRST202' ? 'SCHEMA_MISSING' : 'SERVER'),
          error.code === 'PGRST202'
            ? 'На сервере не установлен модуль опроса. Сообщите преподавателю.'
            : undefined,
        );
      }
      return parse(body);
    } catch (cause) {
      if (cause instanceof SurveyApiError) throw cause;
      if (cause instanceof TypeError || (cause instanceof Error && cause.name === 'AbortError'))
        throw new SurveyApiError(
          'NETWORK',
          'Нет подтверждения от сервера. Проверьте связь и нажмите «Обновить», чтобы узнать, принят ли ответ.',
        );
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  }
  private validate(id: string, token: string) {
    if (!validSurveyId(id) || !validSurveySecret(token)) throw new SurveyApiError('INVALID_INPUT');
  }
  private async mutate<T>(
    name: string,
    args: Record<string, unknown>,
    parse: (value: unknown) => T,
  ) {
    const fingerprint = JSON.stringify(args),
      key = `${name}:${String(args.p_survey_id)}`;
    let receipt = this.receipts.get(key);
    if (!receipt || receipt.fingerprint !== fingerprint) {
      receipt = { fingerprint, id: randomUuid() };
      this.receipts.set(key, receipt);
    }
    const result = await this.rpc(name, { ...args, p_operation_id: receipt.id }, parse);
    this.receipts.delete(key);
    return result;
  }
  manifest(id: string, invite: string) {
    this.validate(id, invite);
    return this.rpc(
      'dw_survey_public_manifest',
      { p_survey_id: id, p_invitation_token: invite },
      parseSurveyPublicManifest,
    );
  }
  own(id: string, secret: string) {
    this.validate(id, secret);
    return this.rpc(
      'dw_survey_own_response',
      { p_survey_id: id, p_response_secret: secret },
      parseSurveyOwnResponse,
    );
  }
  save(id: string, invite: string, secret: string, input: SurveyResponseInput) {
    this.validate(id, invite);
    this.validate(id, secret);
    const parsed = surveyResponseInputSchema.safeParse(input);
    if (!parsed.success) throw new SurveyApiError('INVALID_INPUT');
    return this.mutate(
      'dw_survey_save_response',
      {
        p_survey_id: id,
        p_invitation_token: invite,
        p_response_secret: secret,
        p_input: parsed.data,
      },
      parseSurveyOwnResponse,
    );
  }
  withdraw(id: string, secret: string, revision: number) {
    this.validate(id, secret);
    return this.mutate(
      'dw_survey_withdraw_response',
      { p_survey_id: id, p_response_secret: secret, p_expected_revision: revision },
      parseSurveyOwnResponse,
    );
  }
}

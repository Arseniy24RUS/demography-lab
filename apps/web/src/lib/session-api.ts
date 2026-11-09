import { randomUuid } from '../../../../packages/security/crypto.mjs';
import { createClient, type SupabaseClient, type Session } from '@supabase/supabase-js';
import { DeclaredIdentity, profileRequired, type WorkshopIdentitySession } from './declared-identity';
import { localIdentify } from './offline-api';
import {
  parseBootstrap,
  parseInvitation,
  parseProfile,
  parseProjection,
  parseSnapshot,
  parseBundle,
} from '../../../../packages/collaboration/schema';
import type {
  SessionPatch,
  SessionScope,
  SharedPracticeBundle,
  AvailableSession,
  SessionAreaActions,
} from '../../../../packages/collaboration/types';
import type { CloudConfig } from './cloud-config';

const messages: Record<string, string> = {
  AUTH_REQUIRED: 'Введите email, чтобы продолжить свою работу.',
  EMAIL_NOT_VERIFIED: 'Введите email на странице входа.',
  PROFILE_REQUIRED: 'Укажите ФИО, чтобы участвовать в занятии.',
  FORBIDDEN: 'Для этого действия недостаточно прав. Обновите состояние занятия.',
  NOT_FOUND: 'Занятие или запись недоступны этой учётной записи.',
  INVALID_INPUT: 'Проверьте введённые данные.',
  REVISION_CONFLICT:
    'Запись уже изменена в другом окне. Ваш текст сохранён в форме. Обновите занятие, сравните изменения и повторите действие.',
  IDEMPOTENCY_CONFLICT:
    'Идентификатор операции уже использован с другими данными. Повторите действие после обновления.',
  SESSION_NOT_OPEN:
    'Приём работ приостановлен или занятие закрыто. Ваша локальная работа сохранена.',
  PHASE_CLOSED: 'На этом этапе отправка работ закрыта. Ваша локальная работа сохранена.',
  SOURCE_MISMATCH:
    'Цитата или редакция не совпала с каноническим источником на сервере. Публикация отклонена; локальная работа сохранена.',
  CORPUS_NOT_READY:
    'На сервер ещё не загружена эта редакция документа. Попросите преподавателя выполнить импорт корпуса.',
  LIMIT_EXCEEDED: 'Достигнут предел объёма записи или занятия.',
  INVALID_INVITATION: 'Приглашение недоступно. Откройте ссылку преподавателя или выберите занятие из списка.',
  JOIN_CLOSED: 'Преподаватель закрыл вход в это занятие.',
  RATE_LIMITED: 'Слишком много попыток. Повторите ввод после окончания защитного интервала.',
  IDENTITY_CHANGED: 'Вход уже изменён в другом окне.',
  REGION_UNAVAILABLE: 'Для этого региона ещё нет подготовленного текста на сервере.',
  REGION_TAKEN: 'Программу уже взял другой участник. Обновите карту и выберите свободный регион.',
  COMPLETION_NOTE_REQUIRED:
    'Добавьте практику с цитатой из этого региона или объясните результат отбора (не менее 10 знаков).',
  LEASE_EXPIRED: 'Срок назначения истёк. Обновите карту и снова возьмите программу в работу.',
  ROUND_OPEN:
    'Состав практик зафиксирован на время голосования. Изменения доступны после закрытия раунда.',
  ROUND_CLOSED: 'Приём оценок завершён. Голос не был применён задним числом.',
  ROUND_NOT_READY:
    'Подготовьте непустые семейства практик и откройте обсуждение перед голосованием.',
  NOT_ELIGIBLE:
    'В этом раунде голосуют участники, включённые в его состав при открытии. Следующий раунд учтёт новый состав.',
  FIRST_ROUND_BLIND:
    'Первый раунд проводится со скрытыми промежуточными итогами. Результаты появятся после закрытия.',
  ROUND_IMMUTABLE:
    'Зафиксированная версия раунда сохраняется без изменений. Подготовьте новый раунд для изменённого состава практик.',
  FAMILY_CHANGED:
    'Семейство практик изменилось. Обновите основания и повторно проверьте механизм связи.',
  BARRIER_CHANGED: 'Барьер изменился. Обновите его формулировку перед сохранением связи.',
  SURVEY_EXISTS:
    'В занятии уже есть опрос. Для нового опроса завершите и удалите содержимое предыдущего.',
  SURVEY_IMMUTABLE:
    'После открытия формулировки и условия опроса закреплены. Для другой анкеты нужен новый опрос.',
  SURVEY_CLOSED: 'Приём ответов завершён.',
  SURVEY_EXPIRED: 'Срок хранения опроса истёк. Содержимое ответов недоступно; выполните очистку.',
  SURVEY_PURGED: 'Содержимое опроса уже удалено.',
  SURVEY_FROZEN:
    'Формулировки и условия открытого опроса закреплены. Их изменение требует нового опроса.',
  SURVEY_NOT_OPEN: 'Приём ответов сейчас закрыт.',
  BARRIER_ARCHIVED: 'Барьер находится в архиве. Для новой связи сначала восстановите его.',
  FAMILY_MISSING:
    'Семейство практик больше недоступно. Прежние основания связи сохранены; выберите актуальное семейство.',
  BOARD_LIMIT:
    'Достигнут предел размера коллективной доски. Обсудите структуру материалов с преподавателем.',
  EVIDENCE_LIMIT:
    'Объём документальных оснований слишком велик для одной связи. Разделите семейство практик.',
  EVIDENCE_IMMUTABLE:
    'Закреплённые документальные основания сохраняются без изменений. Обновите связь новой редакцией.',
  DATASET_NOT_READY:
    'На сервер ещё не загружен и не закреплён этот выпуск территорий и статистики. Выполните импорт данных дорожных карт.',
  DATASET_MISMATCH:
    'Занятие закреплено за другим выпуском территориальных данных. Откройте соответствующую версию приложения.',
  ROADMAP_CONFIGURATION_LOCKED: 'Уровень команд уже закреплён созданными дорожными картами.',
  TERRITORY_NOT_ELIGIBLE: 'Эта единица исходной карты не подходит для выбранного уровня команд.',
  TERRITORY_OUT_OF_SCOPE: 'Территория находится вне региона выбранного занятия.',
  ROADMAP_ROOM_REQUIRED:
    'Изменять эту карту могут преподаватель и участники её территориальной команды.',
  ROADMAP_REFERENCE:
    'Проверьте связи с задачами, мероприятиями и статьями затрат. Используемую запись нельзя снять до изменения её связей.',
  ROADMAP_CYCLE: 'Зависимости мероприятий образуют замкнутый круг. Измените предшественников.',
  ROADMAP_LIMIT: 'Достигнут предел записей или объёма одной дорожной карты.',
  STATISTICS_FUTURE_YEAR:
    'Фактическое наблюдение не может относиться к будущему году. Задайте будущие значения в сценарии.',
  ROADMAP_SINGLETON: 'Этот раздел уже существует в общей карте. Откройте его текущую редакцию.',
  ROADMAP_VERSION_LIMIT: 'Достигнут предел числа или суммарного объёма сохранённых версий карты.',
  ROADMAP_VERSION_IMMUTABLE:
    'Зафиксированная версия не изменяется. Создайте новую версию из текущей карты.',
  DATASET_IMMUTABLE: 'Этот выпуск источников уже закреплён и не может быть перезаписан.',
  BUDGET_OVERALLOCATED:
    'Средства по статье превышают её стоимость. Проверьте распределение источников.',
  BUDGET_OVERFLOW: 'Сумма превышает допустимый предел точного денежного расчёта.',
  SCENARIO_HISTORY:
    'Проверьте период истории, пропуски и горизонт сценария. Для линейного расчёта нужны не менее пяти непрерывных наблюдений.',
  SCENARIO_DOMAIN:
    'Способ задания цели или результат несовместимы с допустимыми значениями показателя.',
  SCENARIO_INDICATOR_MISMATCH:
    'Единица, тип, базовое или целевые значения показателя не соответствуют связанному сценарию.',
  SOURCE_ARCHIVED: 'Исходное основание снято с доски. Выберите активный материал обсуждения.',
  SOURCE_STALE:
    'Исходное основание изменилось. Обновите материал и подтвердите его текущую редакцию.',
  SOURCE_VALUE_MISSING: 'Для выбранного года в закреплённом источнике нет числового наблюдения.',
};
export class SessionApiError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(
      message ??
        messages[code] ??
        'Сервер не смог выполнить действие. Попробуйте обновить состояние.',
    );
    this.name = 'SessionApiError';
  }
}
export class SessionApi {
  readonly client: SupabaseClient;
  private readonly entry: DeclaredIdentity | null;
  private identityAttempt = 0;
  private receipts = new Map<string, { fingerprint: string; id: string }>();
  constructor(readonly config: CloudConfig) {
    this.entry = !config.offline && config.identification === 'declared-email' ? new DeclaredIdentity(config) : null;
    this.client = createClient(config.url, config.publishableKey, {
      auth: {
        persistSession: !this.entry,
        autoRefreshToken: !this.entry,
        detectSessionInUrl: false,
        storageKey: `dw-auth-${new URL(config.url).host}`,
      },
      realtime: { params: { eventsPerSecond: 2 } },
    });
  }
  onIdentityChange(listener: (session: WorkshopIdentitySession | null) => void): () => void {
    if (this.entry) return this.entry.onChange(listener);
    const { data: { subscription } } = this.client.auth.onAuthStateChange((_event, session) => listener(session));
    return () => subscription.unsubscribe();
  }
  async identitySession(): Promise<WorkshopIdentitySession | null> {
    if (this.entry) return this.entry.getSession();
    const { data, error } = await this.client.auth.getSession();
    if (error) throw new Error('Не удалось открыть вашу работу. Введите email снова.');
    return data.session;
  }
  async identify(input: { email: string; fullName?: string }): ReturnType<SessionAreaActions['identify']> {
    const attempt = ++this.identityAttempt;
    const email = input.email.normalize('NFC').trim().toLowerCase();
    const fullName = input.fullName?.normalize('NFC').trim().replace(/\s+/gu, ' ');
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(email) || email.length > 254 ||
      (fullName !== undefined && (fullName.length < 2 || fullName.length > 200)))
      throw new SessionApiError('INVALID_INPUT');
    if (this.entry) {
      try {
        const result = await this.entry.identify({ email, ...(fullName === undefined ? {} : { fullName }) });
        if (attempt !== this.identityAttempt) throw new Error('IDENTITY_CHANGED');
        return 'profileRequired' in result ? { status: 'profile-required', email: result.email } : { status: 'signed-in' };
      }
      catch (error) {
        if (error instanceof Error && error.message === 'IDENTITY_CHANGED') throw new SessionApiError('IDENTITY_CHANGED');
        if (error instanceof Error && (error.message === 'INVALID_INPUT' || error.message === 'RATE_LIMITED'))
          throw new SessionApiError(error.message);
        throw new Error('Не удалось войти. Проверьте соединение и повторите действие.');
      }
    }
    if (!this.config.offline) throw new Error('Обновите настройки платформы для входа по email.');
    const result = await localIdentify(this.config, { email, ...(fullName === undefined ? {} : { fullName }) });
    if (attempt !== this.identityAttempt) throw new SessionApiError('IDENTITY_CHANGED');
    const required = profileRequired(result, email);
    if (required) return { status: 'profile-required', email: required.email };
    if (!('session' in result)) throw new Error('Локальный сервер вернул некорректный ответ о входе.');
    await this.acceptLocalSession(result.session);
    return { status: 'signed-in' };
  }
  async acceptLocalSession(session: Session) {
    if (!this.config.offline) throw new Error('Локальный вход недоступен на этом адресе.');
    const { error } = await this.client.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
    if (error) throw new Error('Не удалось сохранить вход. Введите email снова.');
  }
  async acceptHostLink(token: string) {
    if (!this.entry) throw new Error('Ссылка преподавателя недоступна на этом адресе.');
    return this.entry.acceptHostLink(token);
  }
  async signOut() {
    this.identityAttempt += 1;
    this.receipts.clear();
    if (this.entry) return this.entry.signOut();
    const { error } = await this.client.auth.signOut({ scope: 'local' });
    if (error) throw new Error('Не удалось завершить вход. Повторите действие.');
  }
  /** Shared transport for independently versioned feature modules. Authorization stays server-side. */
  async rpc<T>(name: string, args: Record<string, unknown>, parse: (v: unknown) => T): Promise<T> {
    const { data, error } = this.entry ? await this.entry.rpc(name, args) : await this.client.rpc(name, args);
    if (error) {
      const found = Object.keys(messages).find(
        (code) => error.message === code || error.message.startsWith(code + ':'),
      );
      if (found) throw new SessionApiError(found);
      if (error.code === 'PGRST202')
        throw new SessionApiError(
          'SCHEMA_MISSING',
          'Не найдены функции этого модуля. Администратору нужно применить миграции текущего выпуска.',
        );
      if (error.message.toLowerCase().includes('fetch'))
        throw new SessionApiError(
          'NETWORK',
          'Нет ответа от сервера. Локальная тетрадь сохранена; проверьте подключение и повторите действие.',
        );
      throw new SessionApiError('SERVER');
    }
    if (data && typeof data === 'object' && 'error' in data) {
      const body = data.error as { code?: string; retryAfterSeconds?: number };
      if (
        body.code === 'RATE_LIMITED' &&
        typeof body.retryAfterSeconds === 'number' &&
        Number.isFinite(body.retryAfterSeconds)
      ) {
        const minutes = Math.max(1, Math.ceil(body.retryAfterSeconds / 60));
        throw new SessionApiError(
          'RATE_LIMITED',
          `Слишком много попыток. Повторный ввод будет доступен приблизительно через ${minutes} мин.`,
        );
      }
      throw new SessionApiError(body.code ?? 'SERVER');
    }
    return parse(data);
  }
  async mutate<T>(
    name: string,
    args: Record<string, unknown>,
    parse: (v: unknown) => T,
  ): Promise<T> {
    // A cache hint changes response size, never the meaning of a command or its retry identity.
    const { p_known_round_id: _materialHint, ...commandArguments } = args;
    const fingerprint = JSON.stringify(commandArguments);
    const input =
      args.p_input && typeof args.p_input === 'object'
        ? (args.p_input as Record<string, unknown>)
        : {};
    // Keep independently unacknowledged commands, including several creations in
    // one room. A later command must not overwrite the receipt for a lost response.
    const key = `${name}:${String(args.p_session_id ?? 'profile')}:${String(args.p_local_key ?? args.p_submission_id ?? args.p_family_id ?? args.p_region_id ?? args.p_round_id ?? input.barrierId ?? input.linkId ?? input.solutionId ?? input.surveyId ?? input.itemId ?? input.basisId ?? input.versionId ?? input.territoryKey ?? input.roadmapId ?? '')}:${fingerprint}`;
    let receipt = this.receipts.get(key);
    if (!receipt || receipt.fingerprint !== fingerprint) {
      receipt = { fingerprint, id: randomUuid() };
      this.receipts.set(key, receipt);
    }
    const result = await this.rpc(name, { ...args, p_operation_id: receipt.id }, parse);
    if (this.receipts.get(key) === receipt) this.receipts.delete(key);
    if (this.receipts.size > 100) this.receipts.clear();
    return result;
  }
  bootstrap() {
    return this.rpc('dw_bootstrap', {}, parseBootstrap);
  }
  availableSessions() {
    return this.rpc('dw_available_sessions', {}, (value): AvailableSession[] => {
      if (!Array.isArray(value) || value.some((row) => !row || typeof row !== 'object' ||
        typeof row.id !== 'string' || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/iu.test(row.id) ||
        typeof row.title !== 'string' || !['municipality', 'region', 'federal'].includes(row.scope) ||
        (row.regionId !== null && typeof row.regionId !== 'string')))
        throw new Error('Сервер вернул некорректный список занятий.');
      return value as AvailableSession[];
    });
  }
  joinOpenSession(id: string) {
    return this.mutate('dw_join_open_session', { p_session_id: id }, parseSnapshot);
  }
  saveProfile(fullName: string, revision: number) {
    return this.mutate(
      'dw_save_profile',
      { p_full_name: fullName.trim(), p_expected_revision: revision },
      parseProfile,
    );
  }
  createSession(title: string, scope: SessionScope, regionId: string | null) {
    return this.mutate(
      'dw_create_session',
      { p_title: title.trim(), p_scope: scope, p_region_id: regionId },
      parseSnapshot,
    );
  }
  joinSession(code: string) {
    return this.mutate(
      'dw_join_session',
      { p_code: code.trim().replace(/[\s-]/gu, '').toUpperCase() },
      parseSnapshot,
    );
  }
  snapshot(id: string) {
    return this.rpc('dw_session_snapshot', { p_session_id: id }, parseSnapshot);
  }
  cursor(id: string) {
    return this.rpc('dw_session_cursor', { p_session_id: id }, (value) => {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw new Error('Некорректная ревизия занятия.');
      return value;
    });
  }
  projection(id: string) {
    return this.rpc('dw_projector_snapshot', { p_session_id: id }, parseProjection);
  }
  invitation(id: string) {
    return this.rpc('dw_invitation', { p_session_id: id }, parseInvitation);
  }
  updateSession(id: string, expectedRevision: number, patch: SessionPatch) {
    return this.mutate(
      'dw_update_session',
      { p_session_id: id, p_expected_revision: expectedRevision, p_patch: patch },
      parseSnapshot,
    );
  }
  rotateInvitation(id: string, expectedRevision: number) {
    return this.mutate(
      'dw_rotate_invitation',
      { p_session_id: id, p_expected_revision: expectedRevision },
      parseSnapshot,
    );
  }
  publish(
    id: string,
    localKey: string,
    expectedRevision: number | null,
    bundle: SharedPracticeBundle,
  ) {
    return this.mutate(
      'dw_publish_submission',
      {
        p_session_id: id,
        p_local_key: localKey,
        p_expected_revision: expectedRevision,
        p_bundle: parseBundle(bundle),
      },
      parseSnapshot,
    );
  }
  moderate(id: string, submissionId: string, revision: number, status: 'shared' | 'withdrawn') {
    return this.mutate(
      'dw_moderate_submission',
      {
        p_session_id: id,
        p_submission_id: submissionId,
        p_expected_revision: revision,
        p_status: status,
      },
      parseSnapshot,
    );
  }
  setMemberRole(id: string, memberId: string, revision: number, role: 'participant' | 'observer') {
    return this.mutate(
      'dw_set_member_role',
      { p_session_id: id, p_member_id: memberId, p_expected_revision: revision, p_role: role },
      parseSnapshot,
    );
  }
  revokeMember(id: string, memberId: string, revision: number) {
    return this.mutate(
      'dw_revoke_member',
      { p_session_id: id, p_member_id: memberId, p_expected_revision: revision },
      parseSnapshot,
    );
  }
}

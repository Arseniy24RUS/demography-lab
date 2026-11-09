import { validateSurveyDeployment, type SurveyDeployment } from './survey-deployment';
import { isLocalNetworkHost } from './local-network';

export interface CloudConfig {
  url: string;
  publishableKey: string;
  realtime: boolean;
  testEnvironment: boolean;
  pollInterval: number;
  survey?: SurveyDeployment | null;
  surveyError?: string | null;
  /** A local classroom server is an explicitly configured, separate authority. */
  offline?: boolean;
  offlineInstanceId?: string;
  offlineAuthUrl?: string;
  identification?: 'declared-email';
}
export interface CloudConfiguration {
  config: CloudConfig | null;
  error: string | null;
}

export function validateCloudConfiguration(
  input: unknown,
  testEnvironment = false,
  currentOrigin = typeof location === 'undefined' ? null : location.origin,
): CloudConfiguration {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { config: null, error: 'Некорректный файл подключения.' };
  const row = input as Record<string, unknown>;
  if (row.schemaVersion !== 1)
    return { config: null, error: 'Неподдерживаемая версия настроек подключения.' };
  if (!row.supabaseUrl && !row.supabasePublishableKey) return { config: null, error: null };
  try {
    if (typeof row.supabaseUrl !== 'string' || typeof row.supabasePublishableKey !== 'string')
      throw new Error('Укажите адрес Supabase и публичный ключ.');
    const url = new URL(row.supabaseUrl);
    const offline = row.offline === true;
    if (offline && (
      !currentOrigin || url.origin !== currentOrigin || !isLocalNetworkHost(url.hostname) ||
      typeof row.offlineInstanceId !== 'string' ||
      !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/iu.test(row.offlineInstanceId) ||
      (row.offlineAuthUrl !== undefined && row.offlineAuthUrl !== url.origin)
    )) throw new Error('Локальный сервер должен иметь тот же адрес, что и приложение, и идентификатор экземпляра.');
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !((loopback || offline) && url.protocol === 'http:')) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('Нужен HTTPS-адрес Supabase без пути, параметров и учётных данных.');
    const key = row.supabasePublishableKey.trim();
    if (key.startsWith('sb_secret_'))
      throw new Error('Секретный ключ нельзя использовать в браузере. Нужен publishable key.');
    if (!key.startsWith('sb_publishable_')) {
      let claims: { role?: unknown };
      try {
        claims = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      } catch {
        throw new Error('Не распознан публичный ключ Supabase.');
      }
      if (claims.role !== 'anon')
        throw new Error('В браузере разрешён только publishable key или прежний anon key.');
    }
    if (key.length < 20 || key.length > 4000)
      throw new Error('Некорректная длина публичного ключа.');
    const survey = validateSurveyDeployment(row.surveyUrl, row.classroomOrigin,
      offline ? { offline: true, host: url.hostname } : undefined);
    return {
      config: {
        url: url.origin,
        publishableKey: key,
        realtime: !offline && row.identification !== 'declared-email' && row.realtime !== false,
        testEnvironment,
        pollInterval: testEnvironment ? 1000 : offline || row.identification === 'declared-email' ? 2000 : 8000,
        survey: survey.deployment,
        surveyError: survey.error,
        ...(row.identification === 'declared-email' ? { identification: 'declared-email' as const } : {}),
        ...(offline ? { offline, offlineInstanceId: row.offlineInstanceId as string,
          offlineAuthUrl: url.origin } : {}),
      },
      error: null,
    };
  } catch (e) {
    return {
      config: null,
      error: e instanceof Error ? e.message : 'Не удалось прочитать настройки.',
    };
  }
}

let cached: Promise<CloudConfiguration> | null = null;
export function loadCloudConfiguration(): Promise<CloudConfiguration> {
  if (cached) return cached;
  cached = (async () => {
    const env = import.meta.env;
    const testEnvironment =
      env.VITE_WORKSHOP_TEST_MODE === 'true' &&
      ['127.0.0.1', 'localhost'].includes(location.hostname);
    // The same compiled application is distributed for HTTPS and local classrooms.
    // A local server is its own authority even if the build contained cloud env vars.
    // An invalid explicit local configuration must fail closed, never contact cloud.
    let runtime: unknown = null;
    let runtimeError: string | null = null;
    try {
      const response = await fetch(`${env.BASE_URL}workshop-config.json`, { cache: 'no-store' });
      if (response.status !== 404) {
        if (!response.ok) throw new Error(`Ошибка загрузки настроек (${response.status}).`);
        runtime = await response.json();
      }
    } catch (e) {
      runtimeError = e instanceof Error ? e.message : 'Не удалось загрузить настройки подключения.';
    }
    if (runtime && typeof runtime === 'object' && 'offline' in runtime && runtime.offline === true)
      return validateCloudConfiguration(runtime);
    if (env.VITE_SUPABASE_URL || env.VITE_SUPABASE_PUBLISHABLE_KEY)
      return validateCloudConfiguration(
        {
          schemaVersion: 1,
          supabaseUrl: env.VITE_SUPABASE_URL,
          supabasePublishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY,
          realtime: env.VITE_WORKSHOP_REALTIME !== 'false',
          surveyUrl: env.VITE_WORKSHOP_SURVEY_URL,
          classroomOrigin: env.VITE_WORKSHOP_CLASSROOM_ORIGIN,
          identification: 'declared-email',
        },
        testEnvironment,
      );
    if (runtimeError) return { config: null, error: runtimeError };
    return runtime === null ? { config: null, error: null } : validateCloudConfiguration(runtime);
  })();
  return cached;
}

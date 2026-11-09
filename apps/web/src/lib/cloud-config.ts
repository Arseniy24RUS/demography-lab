import { validateSurveyDeployment, type SurveyDeployment } from './survey-deployment';

export interface CloudConfig {
  url: string;
  publishableKey: string;
  realtime: boolean;
  testEnvironment: boolean;
  pollInterval: number;
  survey?: SurveyDeployment | null;
  surveyError?: string | null;
}
export interface CloudConfiguration {
  config: CloudConfig | null;
  error: string | null;
}

export function validateCloudConfiguration(
  input: unknown,
  testEnvironment = false,
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
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
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
    const survey = validateSurveyDeployment(row.surveyUrl, row.classroomOrigin);
    return {
      config: {
        url: url.origin,
        publishableKey: key,
        realtime: row.realtime !== false,
        testEnvironment,
        pollInterval: testEnvironment ? 1000 : 8000,
        survey: survey.deployment,
        surveyError: survey.error,
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
    if (env.VITE_SUPABASE_URL || env.VITE_SUPABASE_PUBLISHABLE_KEY)
      return validateCloudConfiguration(
        {
          schemaVersion: 1,
          supabaseUrl: env.VITE_SUPABASE_URL,
          supabasePublishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY,
          realtime: env.VITE_WORKSHOP_REALTIME !== 'false',
          surveyUrl: env.VITE_WORKSHOP_SURVEY_URL,
          classroomOrigin: env.VITE_WORKSHOP_CLASSROOM_ORIGIN,
        },
        testEnvironment,
      );
    try {
      const response = await fetch(`${env.BASE_URL}workshop-config.json`, { cache: 'no-store' });
      if (response.status === 404) return { config: null, error: null };
      if (!response.ok) throw new Error(`Ошибка загрузки настроек (${response.status}).`);
      return validateCloudConfiguration(await response.json());
    } catch (e) {
      return {
        config: null,
        error: e instanceof Error ? e.message : 'Не удалось загрузить настройки подключения.',
      };
    }
  })();
  return cached;
}

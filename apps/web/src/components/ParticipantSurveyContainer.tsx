import { useEffect, useRef, useState } from 'react';
import { ParticipantSurvey } from './barriers/ParticipantSurvey';
import { loadCloudConfiguration, type CloudConfig } from '../lib/cloud-config';
import {
  assertSurveyOrigin,
  readSurveyInvitation,
  validSurveySecret,
} from '../lib/survey-deployment';
import { SurveyApi } from '../lib/survey-api';
import {
  createSurveyReceipt,
  surveyReceiptText,
  keepSecret,
  newSurveySecret,
  readSecret,
  responseStorageKey,
} from '../lib/survey-secrets';
import type {
  SurveyOwnResponse,
  SurveyPublicManifest,
  SurveyResponseInput,
} from '../../../../packages/barriers/types';

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'Не удалось загрузить анкету.';
const storage = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};
export function ParticipantSurveyContainer() {
  const [route, setRoute] = useState(() => readSurveyInvitation(location.hash));
  const [configuration, setConfiguration] = useState<CloudConfig | null>(null);
  const [manifest, setManifest] = useState<SurveyPublicManifest | null>(null);
  const [response, setResponse] = useState<SurveyOwnResponse | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null),
    [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [secretPresent, setSecretPresent] = useState(false);
  const client = useRef<SurveyApi | null>(null),
    secret = useRef<string | null>(null),
    lock = useRef(false);
  const identity = `${route?.surveyId ?? ''}:${route?.invitationToken ?? ''}`,
    identityRef = useRef(identity);
  identityRef.current = identity;
  useEffect(() => {
    const change = () => setRoute(readSurveyInvitation(location.hash));
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setConfiguration(null);
    setManifest(null);
    setResponse(null);
    setError(null);
    setStorageWarning(null);
    setSecretPresent(false);
    secret.current = null;
    client.current = null;
    lock.current = false;
    setBusy(false);
    void loadCloudConfiguration()
      .then(async (result) => {
        if (!active) return;
        if (!result.config)
          throw new Error(
            result.error ??
              'Подключение опроса ещё не настроено. Преподавателю нужен отдельный адрес формы и сервер этого выпуска.',
          );
        if (!result.config.survey)
          throw new Error(
            result.config.surveyError ??
              'Отдельный адрес анонимной формы ещё не настроен. Сбор личных ответов отключён.',
          );
        assertSurveyOrigin(result.config.survey, location.href);
        if (!route)
          throw new Error(
            'В ссылке отсутствует идентификатор опроса. Откройте приглашение преподавателя или ссылку из личной квитанции.',
          );
        setConfiguration(result.config);
        const api = new SurveyApi(result.config);
        client.current = api;
        const local = storage(),
          saved = local
            ? readSecret(local, responseStorageKey(result.config.url, route.surveyId))
            : null;
        secret.current = saved;
        setSecretPresent(Boolean(saved));
        await load(api, route.surveyId, route.invitationToken, saved, () => active);
      })
      .catch((cause: unknown) => {
        if (active) setError(message(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [identity]);
  async function load(
    api: SurveyApi,
    id: string,
    invitation: string | null,
    ownSecret: string | null,
    active: () => boolean,
  ) {
    const results = await Promise.allSettled([
      invitation ? api.manifest(id, invitation) : Promise.resolve(null),
      ownSecret ? api.own(id, ownSecret) : Promise.resolve(null),
    ]);
    if (!active()) return;
    const [publicResult, ownResult] = results;
    setManifest(publicResult.status === 'fulfilled' ? publicResult.value : null);
    setResponse(ownResult.status === 'fulfilled' ? ownResult.value : null);
    const failure = results.find((r) => r.status === 'rejected');
    setError(
      failure?.status === 'rejected'
        ? message(failure.reason)
        : !invitation && !ownSecret
          ? 'Введите личный ключ из квитанции, чтобы получить или отозвать ответ.'
          : null,
    );
  }
  async function refresh() {
    if (!client.current || !route || lock.current) return;
    const captured = identity;
    setLoading(true);
    try {
      await load(
        client.current,
        route.surveyId,
        route.invitationToken,
        secret.current,
        () => identityRef.current === captured,
      );
    } finally {
      if (identityRef.current === captured) setLoading(false);
    }
  }
  function persist(value: string) {
    if (!route || !configuration) throw new Error('Опрос ещё не открыт.');
    secret.current = value;
    setSecretPresent(true);
    const local = storage();
    if (!local || !keepSecret(local, responseStorageKey(configuration.url, route.surveyId), value))
      setStorageWarning(
        'Браузер запретил сохранение личного ключа. Скачайте квитанцию до закрытия этой страницы: без ключа восстановить или отозвать ответ невозможно.',
      );
  }
  async function mutation(operation: (api: SurveyApi) => Promise<SurveyOwnResponse>) {
    if (!client.current || !route || !configuration) throw new Error('Опрос ещё не открыт.');
    if (lock.current) throw new Error('Дождитесь подтверждения предыдущего действия.');
    const captured = identity;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await operation(client.current);
      if (identityRef.current === captured) setResponse(next);
      return next;
    } catch (cause) {
      if (identityRef.current === captured) setError(message(cause));
      throw cause;
    } finally {
      if (identityRef.current === captured) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  async function save(input: SurveyResponseInput) {
    if (!route?.invitationToken || !manifest?.canRespond)
      throw new Error('Нужно действующее приглашение в открытый опрос.');
    // Generate and persist before the first network write, including when its response is lost.
    if (!secret.current) persist(newSurveySecret());
    return mutation((api) =>
      api.save(route.surveyId, route.invitationToken!, secret.current!, input),
    );
  }
  async function withdraw(revision: number) {
    if (!secret.current || !route) throw new Error('Введите личный ключ.');
    return mutation((api) => api.withdraw(route.surveyId, secret.current!, revision));
  }
  async function restore(value: string) {
    const trimmed = value.trim();
    if (!validSurveySecret(trimmed)) throw new Error('Нужен личный ключ из 64 символов квитанции.');
    if (!client.current || !route || !configuration || lock.current)
      throw new Error('Сначала откройте опрос.');
    const captured = identity;
    const next = await client.current.own(route.surveyId, trimmed);
    if (identityRef.current !== captured) return;
    if (next.status === 'none')
      throw new Error('По этому ключу отправленный ответ не найден. Проверьте квитанцию и опрос.');
    persist(trimmed);
    setResponse(next);
    setError(null);
  }
  function receipt() {
    if (!configuration?.survey || !secret.current || !route) return;
    const data = createSurveyReceipt(route.surveyId, secret.current, configuration.survey.url);
    const blob = new Blob([surveyReceiptText(data)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = 'survey-personal-receipt.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <>
      {storageWarning ? (
        <p className="session-message" role="status">
          {storageWarning}
        </p>
      ) : null}
      <ParticipantSurvey
        key={identity}
        manifest={manifest}
        response={response}
        loading={loading}
        busy={busy}
        error={error}
        secretPresent={secretPresent}
        onSave={save}
        onWithdraw={withdraw}
        onRefresh={refresh}
        onRestoreSecret={restore}
        onRevealSecret={() => secret.current}
        onDownloadReceipt={receipt}
      />
    </>
  );
}

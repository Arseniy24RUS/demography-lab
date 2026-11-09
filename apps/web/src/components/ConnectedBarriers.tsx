import { useEffect, useRef, useState } from 'react';
import { BarrierArea } from './barriers/BarrierArea';
import type { BarrierActions } from './barriers/barriers-ui';
import type { CorpusManifest } from '../lib/corpus';
import { readable } from '../lib/corpus';
import {
  hostInvitationStorageKey,
  invitationDigest,
  keepSecret,
  newSurveySecret,
  readSecret,
} from '../lib/survey-secrets';
import { surveyLink } from '../lib/survey-deployment';
import type { SessionApi } from '../lib/session-api';
import { BarriersApi } from '../lib/barriers-api';
import type { useBarriers } from '../hooks/useBarriers';
import type {
  SessionAreaActions,
  SessionAreaState,
} from '../../../../packages/collaboration/types';
import '../barriers.css';
import { useOfflineShareUrl } from '../hooks/useOfflineShareUrl';

export function ConnectedBarriers({
  state,
  sessionActions,
  barriers,
  manifest,
  api,
  surveyOnly = false,
}: {
  state: SessionAreaState;
  sessionActions: SessionAreaActions;
  barriers: ReturnType<typeof useBarriers>;
  manifest: CorpusManifest;
  api: SessionApi | null;
  surveyOnly?: boolean;
}) {
  const [invitationUrl, setInvitationUrl] = useState<string | null>(null),
    [invitationError, setInvitationError] = useState<string | null>(null);
  const sharedInvitationUrl = useOfflineShareUrl(invitationUrl);
  const current = state.snapshot?.session,
    userId = state.auth.userId;
  const key =
    api && current && userId ? hostInvitationStorageKey(api.config.url, userId, current.id) : null;
  const pendingMemory = useRef<{ key: string; attempt: string; token: string } | null>(null);
  const currentMemory = useRef<{ key: string; token: string } | null>(null);
  const storageMessage =
    'Браузер запретил сохранение приглашения. Скопируйте общую ссылку до закрытия вкладки; после перезагрузки потребуется заменить приглашение.';
  const survey = barriers.snapshot?.survey;
  const invitationRef = useRef(barriers.invitation);
  invitationRef.current = barriers.invitation;
  useEffect(() => {
    let active = true;
    setInvitationUrl(null);
    setInvitationError(null);
    if (!key || !api || current?.role !== 'host' || !survey) return;
    if (!api.config.survey) {
      setInvitationError(
        api.config.surveyError ?? 'Для общей ссылки настройте отдельный origin формы опроса.',
      );
      return;
    }
    const surveyId = survey.id;
    if (surveyOnly) {
      void new BarriersApi(api).workshopSurvey(current.id).then((entry) => {
        if (!active) return;
        if (entry.invitationToken && entry.survey.canRespond)
          setInvitationUrl(surveyLink(api.config.survey!, entry.survey.id, entry.invitationToken));
      }).catch((cause: unknown) => {
        if (active) setInvitationError(cause instanceof Error ? cause.message : 'Не удалось загрузить форму.');
      });
      return () => { active = false; };
    }
    void invitationRef
      .current(surveyId)
      .then(async (host) => {
        let accepted: string | null = null,
          persisted = false;
        try {
          const pending = readSecret(localStorage, key + ':pending'),
            saved = readSecret(localStorage, key);
          for (const candidate of [pending, saved])
            if (candidate && (await invitationDigest(candidate)) === host.invitationDigest) {
              accepted = candidate;
              break;
            }
        } catch {
          /* An explicitly generated key may still be available in this tab. */
        }
        for (const memory of [pendingMemory.current, currentMemory.current]) {
          if (
            !accepted &&
            memory?.key === key &&
            (await invitationDigest(memory.token)) === host.invitationDigest
          )
            accepted = memory.token;
        }
        if (!active) return;
        if (accepted) {
          try {
            persisted =
              keepSecret(localStorage, key, accepted) || readSecret(localStorage, key) === accepted;
            if (persisted) {
              localStorage.removeItem(key + ':pending');
              localStorage.removeItem(key + ':attempt');
            }
          } catch {
            /* The copy in this tab remains available, with an explicit warning. */
          }
          currentMemory.current = { key, token: accepted };
          setInvitationUrl(surveyLink(api.config.survey!, surveyId, accepted));
          if (pendingMemory.current?.key === key && pendingMemory.current.token === accepted)
            pendingMemory.current = null;
          if (!persisted) setInvitationError(storageMessage);
        } else
          setInvitationError(
            'Ключ приглашения отсутствует на этом устройстве или был заменён. Создайте новую общую ссылку. Личные ключи участников сохранят действие.',
          );
      })
      .catch((cause: unknown) => {
        if (active)
          setInvitationError(
            cause instanceof Error ? cause.message : 'Не удалось проверить приглашение.',
          );
      });
    return () => {
      active = false;
    };
  }, [key, api, current?.role, current?.id, survey?.id, survey?.revision, surveyOnly]);
  if (!current || !userId || !api || !key) return null;
  function candidate(attempt: string) {
    let token: string | null = null;
    try {
      if (localStorage.getItem(key! + ':attempt') === attempt)
        token = readSecret(localStorage, key! + ':pending');
    } catch {
      /* Continue with this tab's memory. */
    }
    if (!token && pendingMemory.current?.key === key && pendingMemory.current.attempt === attempt)
      token = pendingMemory.current.token;
    token ??= newSurveySecret();
    pendingMemory.current = { key: key!, attempt, token };
    let persisted = false;
    try {
      localStorage.setItem(key! + ':attempt', attempt);
      persisted = keepSecret(localStorage, key! + ':pending', token);
    } catch {
      /* Surface storage denial while retaining a retry key in memory. */
    }
    if (!persisted) setInvitationError(storageMessage);
    return token;
  }
  const actions: BarrierActions = {
    ...barriers.actions,
    saveSurvey: (input) =>
      barriers.actions.saveSurvey(
        input.surveyId ? input : { ...input, invitationToken: candidate('create') },
      ),
    manageSurvey: (input) =>
      barriers.actions.manageSurvey(
        input.action === 'rotate'
          ? {
              ...input,
              invitationToken: candidate(`rotate:${input.surveyId}:${input.expectedRevision}`),
            }
          : input,
      ),
  };
  const regions = manifest.documents.map((entry) => ({
    id: entry.regionId,
    name: entry.territory,
    hasDocument: readable(entry),
    documentTitle: entry.title,
  }));
  return (
    <BarrierArea
      surveyOnly={surveyOnly}
      session={current}
      snapshot={barriers.snapshot}
      userId={userId}
      regions={regions}
      actions={actions}
      loading={barriers.loading}
      error={barriers.error}
      onRefresh={barriers.refresh}
      onOpenSource={sessionActions.openSource}
      surveyInvitationUrl={sharedInvitationUrl}
      surveyInvitationError={invitationError}
    />
  );
}

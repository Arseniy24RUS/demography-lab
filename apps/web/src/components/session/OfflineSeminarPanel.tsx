import { useEffect, useId, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { HardDrive, RefreshCw, ShieldCheck, Wifi } from 'lucide-react';
import type { SessionAreaActions, SessionAreaState } from '../../../../../packages/collaboration/types';
import { type LocalServerStatus } from '../../lib/offline-api';
import { isLocalNetworkHost, isLoopbackHost } from '../../lib/local-network';
import { Modal } from '../Modal';
import { messageFromError } from './session-ui';
import { selectLocalShareAddress, readLocalShareAddress } from '../../lib/offline-share';

const wifiEscape = (value: string) => value.replace(/([\\;,:"])/gu, '\\$1');
export function OfflineSeminarPanel({ state, actions }: { state: SessionAreaState; actions: SessionAreaActions }) {
  const id = useId();
  const [status, setStatus] = useState<LocalServerStatus | null>(null);
  const [host, setHost] = useState(() => readLocalShareAddress(state.offline!.instanceId)?.host ?? '');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [showConnection, setShowConnection] = useState(false);
  const [ssid, setSsid] = useState('');
  const [wifiPassword, setWifiPassword] = useState('');
  const actionsRef = useRef(actions); actionsRef.current = actions;
  const local = state.offline!;
  const canOperate = local.hostAvailable && state.bootstrap?.canCreateSession === true;
  const identity = state.auth.userId;
  const identityRef = useRef(identity); identityRef.current = identity;
  useEffect(() => {
    setStatus(null); setError('');
    if (!canOperate || !identity) return;
    let active = true;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void actionsRef.current.localServerStatus!().then((value) => {
        if (active) { setStatus(value); setError(''); }
      }).catch((cause) => { if (active) setError(messageFromError(cause)); });
    };
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => { active = false; clearInterval(interval); };
  }, [canOperate, identity, state.snapshot?.session.id]);
  const hosts = (status?.lanHosts ?? []).filter((value) => isLocalNetworkHost(value) && !isLoopbackHost(value));
  const selectedHost = hosts.includes(host) ? host : hosts[0] ?? '';
  useEffect(() => {
    if (selectedHost && status) selectLocalShareAddress(local.instanceId, { host: selectedHost, joinCode: status.joinCode });
  }, [selectedHost, status?.joinCode, local.instanceId]);
  const link = selectedHost && status ? new URL(`http://${selectedHost}:${status.port}/`) : null;
  if (link && status) link.hash = new URLSearchParams(state.snapshot
    ? { session: state.snapshot.session.id } : { sessions: '1' }).toString();
  async function refresh(backup = false) {
    const expected = identityRef.current;
    setWorking(true); setError('');
    try {
      if (backup) await actionsRef.current.localBackup!();
      const value = await actionsRef.current.localServerStatus!();
      if (identityRef.current === expected) setStatus(value);
    } catch (cause) { if (identityRef.current === expected) setError(messageFromError(cause)); }
    finally { if (identityRef.current === expected) setWorking(false); }
  }
  return (
    <section className="offline-seminar-panel" aria-label="Локальное сохранение и подключение">
      <div className="offline-seminar-summary">
        <HardDrive size={20} aria-hidden="true" />
        <div><strong>Семинар в локальной сети</strong>
          <p>Общая работа сохраняется на Mac преподавателя. Интернет для занятия не требуется.</p></div>
      </div>
      {canOperate ? <details className="offline-operator" open={!state.snapshot}>
        <summary>Подключение аудитории и резервная копия</summary>
        {status ? <>
          <div className="offline-operator-grid">
            <div><span className="offline-eyebrow">Данные на этом Mac</span>
              <p className="offline-data-count">{status.counts.documents} документов · {status.counts.territories.toLocaleString('ru-RU')} территорий</p>
              <p className="session-hint">{status.counts.series.toLocaleString('ru-RU')} статистических рядов · {status.counts.sessions} занятий</p>
              <p className="session-hint">{status.lastBackup
                ? `Последняя резервная копия: ${new Date(status.lastBackup.createdAt).toLocaleString('ru-RU')}`
                : 'Первая резервная копия ещё не создана.'}</p>
              {status.lastBackup ? <p className="offline-backup-path">{status.lastBackup.path}</p> : null}
            </div>
            <div><span className="offline-eyebrow">Вход участников</span>
              <strong>Только email и ФИО</strong>
              <p className="session-hint">Покажите QR-код платформы. После входа участник продолжит свою работу.</p></div>
          </div>
          <div className="session-action-row">
            <button className="button button-primary" disabled={!link || working} onClick={() => setShowConnection(true)}><Wifi size={17} /> Показать подключение на экране</button>
            <button className="button button-secondary" disabled={working || Boolean(state.busy)} onClick={() => void refresh(true)}><ShieldCheck size={17} /> Создать резервную копию</button>
            <button className="button button-quiet" disabled={working} onClick={() => void refresh()}><RefreshCw size={16} /> Проверить</button>
          </div>
          {!link ? <p className="session-message" data-tone="warning">Не найден адрес локальной сети. Подключите Mac к Wi-Fi роутера или включите общий интернет через отдельное сетевое подключение в настройках macOS.</p> : null}
          <p className="session-hint">Если после запуска сервера вы изменили Wi-Fi или включили общий доступ macOS, остановите и снова запустите семинар, чтобы обновить адреса. Сохранённая работа останется в базе.</p>
        </> : <p role="status">Проверяем локальный сервер…</p>}
        {error ? <p className="session-form-error" role="alert">{error}</p> : null}
      </details> : null}
      {showConnection && status && link ? <Modal title="Подключение к мастерской" onClose={() => setShowConnection(false)} wide>
        <p>Сначала подключитесь к Wi-Fi аудитории, затем откройте мастерскую по QR-коду.</p>
        <div className="offline-connect-settings">
          <label htmlFor={`${id}-interface`}>Адрес Mac в сети</label>
          <select id={`${id}-interface`} className="session-input" value={selectedHost} onChange={(event) => setHost(event.target.value)}>
            {hosts.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <label htmlFor={`${id}-ssid`}>Название Wi-Fi (для первого QR-кода)</label>
          <input id={`${id}-ssid`} className="session-input" value={ssid} onChange={(e) => setSsid(e.target.value)} maxLength={32} />
          <label htmlFor={`${id}-wifi-password`}>Пароль Wi-Fi</label>
          <input id={`${id}-wifi-password`} className="session-input" type="password" autoComplete="off" value={wifiPassword} onChange={(e) => setWifiPassword(e.target.value)} maxLength={63} />
        </div>
        <div className="offline-qr-grid">
          <section><h3>1. Сеть аудитории</h3>
            {ssid ? <QRCodeSVG value={`WIFI:T:${wifiPassword ? 'WPA' : 'nopass'};S:${wifiEscape(ssid)};P:${wifiEscape(wifiPassword)};;`} size={220} level="M" marginSize={4} title="Подключиться к Wi-Fi аудитории" />
              : <div className="offline-qr-placeholder"><Wifi size={54} /><p>Выберите сеть аудитории в настройках Wi-Fi</p></div>}
            <strong>{ssid || 'Wi-Fi аудитории'}</strong>
            <p className="session-hint">Если телефон сообщает об отсутствии интернета, сохраните подключение к этой сети.</p>
          </section>
          <section><h3>2. Мастерская</h3>
            <QRCodeSVG value={link.href} size={220} level="M" marginSize={4} title="Открыть демографическую мастерскую" />
            <a href={link.href} target="_blank" rel="noreferrer">{link.origin}</a>
            <p className="session-hint">Откройте мастерскую и укажите email и ФИО.</p>
          </section>
        </div>
      </Modal> : null}
    </section>
  );
}

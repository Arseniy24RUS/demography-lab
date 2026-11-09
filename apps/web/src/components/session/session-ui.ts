import type {
  ConnectionStatus,
  SessionPhase,
  SessionRole,
  SessionScope,
  SessionStatus,
} from '../../../../../packages/collaboration/types';

export const roleLabels: Record<SessionRole, string> = {
  host: 'Преподаватель',
  participant: 'Участник',
  observer: 'Наблюдатель',
};
export const phaseLabels: Record<SessionPhase, string> = {
  reading: 'Чтение программ',
  review: 'Сопоставление практик',
  discussion: 'Общее обсуждение',
};
export const statusLabels: Record<SessionStatus, string> = {
  open: 'Приём работ открыт',
  paused: 'Сбор приостановлен',
  closed: 'Занятие завершено',
};
export const scopeLabels: Record<SessionScope, string> = {
  municipality: 'Муниципальный',
  region: 'Региональный',
  federal: 'Федеральный',
};
export const connectionLabels: Record<ConnectionStatus, string> = {
  unconfigured: 'Совместная работа не подключена',
  connecting: 'Подключаемся',
  live: 'Связь установлена',
  polling: 'Обновляется автоматически',
  offline: 'Нет связи',
  error: 'Требуется переподключение',
};

export function messageFromError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Не удалось выполнить действие. Попробуйте ещё раз.';
}

export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join('')
    .toLocaleUpperCase('ru');
}

export function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? ''
    : new Intl.DateTimeFormat('ru-RU', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
}

export function timeLabel(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? ''
    : new Intl.DateTimeFormat('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).format(date);
}

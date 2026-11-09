import { useRef, useState } from 'react';
import type { MouseEvent, PointerEvent, ReactNode } from 'react';
import { AlertCircle, Info, LoaderCircle } from 'lucide-react';
import type {
  BarrierCard,
  BarrierPracticeLink,
  LifeStage,
} from '../../../../../packages/barriers/types';
import { lifeStages } from '../../../../../packages/barriers/types';

export { lifeStages };
export const stageLabels: Record<LifeStage, string> = {
  life_plans: 'Жизненные планы',
  first_child: 'Первый ребёнок',
  preparation_pregnancy: 'Подготовка и беременность',
  infancy: 'Первый год',
  early_childhood: 'От 1 до 3 лет',
  preschool: 'Дошкольный период',
  school: 'Школьный период',
  next_child: 'Следующий ребёнок',
};
export const stageDescriptions: Record<LifeStage, string> = {
  life_plans: 'Планы, отношения, представления о семье и доступные возможности.',
  first_child: 'Условия принятия решения о первом ребёнке.',
  preparation_pregnancy: 'Подготовка к зачатию, репродуктивное здоровье и беременность.',
  infancy: 'Рождение ребёнка, восстановление и уход в первый год.',
  early_childhood: 'Уход за ребёнком от года до трёх и возвращение к занятости.',
  preschool: 'Доступность дошкольного ухода и повседневная жизнь семьи.',
  school: 'Образование, досуг и согласование семейных и рабочих обязанностей.',
  next_child: 'Решение о следующем ребёнке с учётом накопленного опыта родительства.',
};
export const evidenceLabels = {
  observation: 'Наблюдение',
  hypothesis: 'Гипотеза',
  survey_summary: 'Обобщение опроса',
};
export const relationshipLabels = {
  potential: 'Возможная связь',
  partial: 'Частичное решение',
  needs_adaptation: 'Требует адаптации',
};
export const staleLabels = {
  barrier_changed: 'Формулировка барьера изменилась',
  barrier_archived: 'Барьер в архиве',
  family_changed: 'Семейство или публикации изменились',
  family_missing: 'Семейство больше не доступно',
};
export function currentLinks(links: BarrierPracticeLink[], barrierId: string) {
  return links.filter(
    (link) => link.barrierId === barrierId && link.status === 'active' && !link.staleReasons.length,
  );
}
export function coverageLabel(links: BarrierPracticeLink[], barrierId: string) {
  if (currentLinks(links, barrierId).length) return 'Есть актуальная связь';
  if (links.some((link) => link.barrierId === barrierId && link.status === 'active'))
    return 'Связи требуют проверки';
  return 'Практика ещё не подобрана';
}
export function canEditCard(
  card: Pick<BarrierCard, 'authorId'>,
  userId: string,
  isHost: boolean,
  editable: boolean,
) {
  return editable && (isHost || card.authorId === userId);
}
export function errorText(cause: unknown) {
  const value =
    cause instanceof Error ? cause.message : 'Не удалось выполнить действие. Попробуйте ещё раз.';
  if (/REVISION_CONFLICT|STALE_FAMILY|STALE_BARRIER/i.test(value))
    return 'Данные изменились у другого участника. Ваш текст сохранён в форме. Сравните актуальную редакцию перед повторным сохранением.';
  if (/SESSION_NOT_OPEN|SESSION_CLOSED|SESSION_PAUSED/i.test(value))
    return 'Занятие приостановлено или завершено. Ваш текст остался в форме.';
  return value;
}
export function useBarrierTask() {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lock = useRef(false);
  async function run<T>(
    action: () => Promise<T>,
    success?: (value: T) => void,
    message?: string,
  ): Promise<boolean> {
    if (lock.current) return false;
    lock.current = true;
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      const value = await action();
      success?.(value);
      if (message) setNotice(message);
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }
  return {
    working,
    error,
    notice,
    run,
    clear: () => {
      setError(null);
      setNotice(null);
    },
  };
}
export function TaskMessage({ error, notice }: { error?: string | null; notice?: string | null }) {
  return (
    <>
      {error ? (
        <p className="barrier-feedback error" role="alert">
          <AlertCircle size={17} />
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="barrier-feedback" role="status">
          <Info size={17} />
          {notice}
        </p>
      ) : null}
    </>
  );
}
export function Busy({ children = 'Загружаем данные…' }: { children?: ReactNode }) {
  return (
    <p className="barrier-feedback" role="status">
      <LoaderCircle className="barrier-spinner" size={18} />
      {children}
    </p>
  );
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="barrier-empty">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
export function StageChips({
  stageIds,
  primaryStage,
}: {
  stageIds: LifeStage[];
  primaryStage: LifeStage;
}) {
  return (
    <div className="barrier-chips" aria-label="Этапы барьера">
      {stageIds.length === lifeStages.length ? (
        <span className="barrier-chip">Все этапы · основной: {stageLabels[primaryStage]}</span>
      ) : (
        stageIds.map((stage) => (
          <span className={`barrier-chip${stage === primaryStage ? ' primary' : ''}`} key={stage}>
            {stageLabels[stage]}
            {stage === primaryStage ? (
              <span className="barrier-sr-only"> (основной этап)</span>
            ) : null}
          </span>
        ))
      )}
    </div>
  );
}
export function RevisionNotice({
  changed,
  onAccept,
  children,
}: {
  changed: boolean;
  onAccept: () => void;
  children?: ReactNode;
}) {
  if (!changed) return null;
  return (
    <section className="barrier-conflict" role="status">
      <strong>Появилась новая редакция.</strong>
      <p>
        Текст в этой форме сохранён. Сравните изменения и явно подтвердите использование новой
        редакции.
      </p>
      {children}
      <button type="button" className="button button-secondary" onClick={onAccept}>
        Сохранить мой текст поверх новой редакции
      </button>
    </section>
  );
}
/** The handle owns touch gestures; ordinary buttons provide the same operation. */
export function useBarrierDrag(
  selector: string,
  attribute: string,
  onDrop: (id: string, target: string) => void,
  onChoose: (id: string) => void,
) {
  const [drag, setDrag] = useState<{
    id: string;
    title: string;
    x: number;
    y: number;
    over: string | null;
  } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const active = useRef<{ id: string; title: string; x: number; y: number; moved: boolean } | null>(
    null,
  );
  const suppressClick = useRef(0);
  function targetAt(x: number, y: number) {
    return (
      document.elementFromPoint(x, y)?.closest<HTMLElement>(selector)?.getAttribute(attribute) ??
      null
    );
  }
  function start(event: PointerEvent<HTMLButtonElement>, id: string, title: string) {
    if (event.button !== 0) return;
    active.current = { id, title, x: event.clientX, y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const value = active.current;
    if (!value) return;
    if (!value.moved && Math.hypot(value.x - event.clientX, value.y - event.clientY) < 8) return;
    value.moved = true;
    setDrag({
      id: value.id,
      title: value.title,
      x: event.clientX,
      y: event.clientY,
      over: targetAt(event.clientX, event.clientY),
    });
  }
  function finish(event: PointerEvent<HTMLButtonElement>) {
    const value = active.current;
    active.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (value?.moved) {
      suppressClick.current = Date.now() + 300;
      const target = targetAt(event.clientX, event.clientY);
      if (target) {
        onDrop(value.id, target);
        setAnnouncement('Проверьте и подтвердите изменение в открывшемся окне.');
      } else setAnnouncement('Перенос отменён. Данные не изменились.');
    }
    setDrag(null);
  }
  function cancel() {
    active.current = null;
    setDrag(null);
    setAnnouncement('Перенос отменён.');
  }
  function click(event: MouseEvent<HTMLButtonElement>, id: string) {
    if (Date.now() < suppressClick.current) {
      event.preventDefault();
      return;
    }
    onChoose(id);
  }
  return { drag, announcement, start, move, finish, cancel, click };
}

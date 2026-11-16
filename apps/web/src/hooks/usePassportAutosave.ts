import { useEffect, useRef, useState } from 'react';
import { roadmapPassportDataSchema } from '../../../../packages/roadmaps/schema';
import type { RoadmapItem, RoadmapPassportData, RoadmapSnapshot } from '../../../../packages/roadmaps/types';
import type { RoadmapsController } from './useRoadmaps';
import { passportFieldGroups, reconcilePassport, samePassportValue, type PassportChanges } from '../lib/passport-draft';

const validationMessage = 'Для периода укажите обе даты. Начало должно быть не позднее окончания.';
const isConflict = (cause: unknown) => cause instanceof Error && 'code' in cause && cause.code === 'REVISION_CONFLICT';
const passportOf = (snapshot: RoadmapSnapshot | null) => snapshot?.items.find(
  (item): item is RoadmapItem<'passport'> => item.kind === 'passport' && item.status === 'active',
);
type Draft = { itemId: string; base: RoadmapPassportData; changes: PassportChanges };

/** One queue per open team. The latest server revision guards each committed merge. */
export function usePassportAutosave(snapshot: RoadmapSnapshot | null, controller: RoadmapsController, editable: boolean) {
  const item = passportOf(snapshot);
  const draft = useRef<Draft | null>(null);
  const pending = useRef<Promise<boolean> | null>(null);
  const [, render] = useState(0);
  const [working, setWorking] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const tick = () => render(value => value + 1);
  const context = useRef({ controller, editable });
  context.current = { controller, editable };
  const activeDraft = draft.current?.itemId === item?.id ? draft.current : null;
  const preview = activeDraft && item ? reconcilePassport(activeDraft.base, activeDraft.changes, item.data) : null;

  function update(changes: PassportChanges) {
    const latest = passportOf(context.current.controller.actions.currentSnapshot());
    if (!latest || !context.current.editable) return;
    const current = draft.current?.itemId === latest.id ? draft.current : null;
    const next: Draft = current ? { ...current, base: { ...current.base }, changes: { ...current.changes } }
      : { itemId: latest.id, base: latest.data, changes: {} };
    // Newly touched groups start at the values the participant actually saw.
    for (const group of passportFieldGroups) {
      if (!group.some(field => Object.hasOwn(changes, field))) continue;
      if (current && !group.some(field => Object.hasOwn(current.changes, field)))
        for (const field of group) Object.assign(next.base, { [field]: item?.id === latest.id ? item.data[field] : latest.data[field] });
    }
    Object.assign(next.changes, changes);
    draft.current = next;
    setError('');
    setSaved(false);
    tick();
  }

  async function commit(overwrite: boolean): Promise<boolean> {
    const { controller: current, editable: allowed } = context.current;
    for (let retry = 0; retry < 2; retry++) {
      const opened = current.actions.currentSnapshot();
      const latest = passportOf(opened);
      const edit = draft.current;
      if (!edit) return true;
      if (!allowed || !opened || !latest || edit.itemId !== latest.id) return false;
      const merge = reconcilePassport(edit.base, edit.changes, latest.data);
      if (merge.conflicts.length && !(overwrite && retry === 0)) {
        tick();
        return false;
      }
      const parsed = roadmapPassportDataSchema.safeParse(merge.data);
      if (!parsed.success) { setError(validationMessage); return false; }
      if (samePassportValue(merge.data, latest.data)) {
        if (draft.current === edit) draft.current = null;
        setSaved(true);
        tick();
        return true;
      }
      try {
        const next = await current.actions.saveItem({
          kind: 'passport', roadmapId: opened.roadmapId, itemId: latest.id,
          expectedRevision: latest.revision, status: 'active', data: parsed.data,
        });
        const confirmed = passportOf(next);
        const waiting = draft.current;
        if (waiting === edit) draft.current = null;
        else if (waiting?.itemId === latest.id && confirmed) {
          const changes = { ...waiting.changes };
          const base = { ...waiting.base };
          for (const group of passportFieldGroups) {
            if (!group.some(field => Object.hasOwn(edit.changes, field))) continue;
            if (group.every(field => samePassportValue(waiting.changes[field], edit.changes[field])))
              for (const field of group) delete changes[field];
            for (const field of group) Object.assign(base, { [field]: confirmed.data[field] });
          }
          draft.current = Object.keys(changes).length ? { ...waiting, base, changes } : null;
        }
        setSaved(!draft.current);
        tick();
        return true;
      } catch (cause) {
        if (isConflict(cause) && retry === 0) {
          await current.actions.refresh();
          continue;
        }
        setError(cause instanceof Error ? cause.message : 'Не удалось сохранить паспорт.');
        return false;
      }
    }
    return false;
  }

  async function flush(overwrite = false): Promise<boolean> {
    while (draft.current) {
      if (pending.current) {
        if (!await pending.current) return false;
        continue;
      }
      setError('');
      setWorking(true);
      const saving = commit(overwrite);
      pending.current = saving;
      let result: boolean;
      try { result = await saving; }
      finally { pending.current = null; setWorking(false); }
      if (!result) return false;
      overwrite = false;
    }
    return true;
  }

  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => { setSaved(false); setError(''); }, [item?.id]);
  useEffect(() => {
    if (!editable || !activeDraft || working || controller.busy || preview?.conflicts.length || error) return;
    const timer = window.setTimeout(() => void flushRef.current(), 650);
    return () => window.clearTimeout(timer);
  }, [editable, activeDraft, working, controller.busy, preview?.conflicts.length, error]);

  useEffect(() => {
    if (!activeDraft) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const retry = () => void flushRef.current();
    window.addEventListener('beforeunload', protect);
    window.addEventListener('online', retry);
    return () => { window.removeEventListener('beforeunload', protect); window.removeEventListener('online', retry); };
  }, [Boolean(activeDraft)]);

  return {
    item, data: preview?.data ?? item?.data, dirty: Boolean(activeDraft),
    conflicts: preview?.conflicts ?? [], working, saved, error, update, flush,
    acceptTeamVersion() {
      const edit = draft.current;
      const latest = passportOf(context.current.controller.actions.currentSnapshot());
      if (pending.current || !edit || !latest || edit.itemId !== latest.id) return;
      const { conflicts } = reconcilePassport(edit.base, edit.changes, latest.data);
      const changes = { ...edit.changes };
      for (const group of passportFieldGroups) if (conflicts.includes(group[0]))
        for (const field of group) delete changes[field];
      draft.current = Object.keys(changes).length ? { ...edit, changes } : null;
      setError(''); setSaved(false); tick();
    },
    discard() {
      if (pending.current) return;
      draft.current = null; setError(''); setSaved(false); tick();
    },
  };
}

export type PassportAutosave = ReturnType<typeof usePassportAutosave>;

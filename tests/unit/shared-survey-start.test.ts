// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectedSurveyStart } from '../../apps/web/src/components/ConnectedSurveyStart';
import { parseWorkshopSurveyEntry } from '../../packages/barriers/schema';
import type { WorkshopSurveyEntry } from '../../packages/barriers/types';
import type { SessionSummary } from '../../packages/collaboration/types';
import type { SessionApi } from '../../apps/web/src/lib/session-api';
import { createSurveyReceipt, surveyReceiptText } from '../../apps/web/src/lib/survey-secrets';
const call = vi.hoisted(() => vi.fn());
vi.mock('../../apps/web/src/lib/barriers-api', () => ({ BarriersApi: class { workshopSurvey(id: string) { return call(id); } } }));
const id = '00000000-0000-4000-8000-000000000991';
const session: SessionSummary = { id, title: 'Мастерская', role: 'participant', scope: 'municipality', regionId: 'respublika-mordoviia', status: 'open', phase: 'reading', joinOpen: true, revision: 1, focusSubmissionId: null, projectorShowAuthors: false, createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z' };
const entry: WorkshopSurveyEntry = { sessionId: id, invitationToken: 'a'.repeat(64), survey: {
 id: '00000000-0000-4000-8000-000000000992', title: 'Что мешает родительству?', purpose: 'Добровольное обсуждение опыта участников мастерской.', organizerContact: 'organizer@example.test', retentionUntil: '2026-12-09', status: 'open', expired: false, canRespond: true, questionVersion: 1, questionnaireVersion: 'demography-open-1', procedureVersion: 'classroom-open-link-1', revision: 1, responseCount: null,
 questions: {q00:'С какой позиции?',q05_12m:'Планы на год',q05_36m:'Планы на три года',q01:'Что сейчас мешает решиться на рождение ребёнка?',q02:'Что должно измениться, чтобы вероятность рождения ребёнка стала выше?',q03:'Приоритет',q04:'Горизонт',q06:'Изменение намерения',q07:'Другие условия',q08:'Согласие'},
} };
const api = { config: { survey: { url:'https://survey.example.test/survey.html', classroomOrigin:'https://class.example.test' } } } as SessionApi;
afterEach(cleanup);
beforeEach(() => call.mockReset());
describe('shared workshop survey entry', () => {
 it('offers any participant one anonymous button, preserves the separate origin and omits a small count', async () => {
  call.mockResolvedValue(entry);
  const next = vi.fn();
  render(createElement(ConnectedSurveyStart,{api,session,userId:'participant',onContinue:next}));
  const link = await screen.findByRole('link',{name:'Ответить анонимно'});
  expect(link.getAttribute('href')).toBe(`https://survey.example.test/survey.html#survey=${entry.survey.id}&invite=${entry.invitationToken}`);
  expect(link.getAttribute('rel')).toContain('noreferrer');
  expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(screen.queryByText(/^Ответов:/)).toBeNull();
  expect(screen.queryByText(/Создать опрос|Пригласить|Разрешить присоединение/)).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'К барьерам'})); expect(next).toHaveBeenCalledOnce();
 });
 it('does not expose host analysis to a participant', async () => {
  call.mockResolvedValue(entry);
  render(createElement(ConnectedSurveyStart,{api,session,userId:'participant',onContinue:vi.fn()},createElement('p',null,'Частные ответы')));
  await screen.findByRole('link',{name:'Ответить анонимно'});
  expect(screen.queryByText('Частные ответы')).toBeNull();
 });
 it('ignores late metadata from the preceding workshop after switching identity', async () => {
  let resolveOld!: (v:WorkshopSurveyEntry)=>void;
  call.mockImplementationOnce(()=>new Promise<WorkshopSurveyEntry>(resolve=>{resolveOld=resolve;})).mockResolvedValue({...entry,sessionId:'00000000-0000-4000-8000-000000000993',invitationToken:'b'.repeat(64)});
  const view=render(createElement(ConnectedSurveyStart,{api,session,userId:'a',onContinue:vi.fn()}));
  view.rerender(createElement(ConnectedSurveyStart,{api,session:{...session,id:'00000000-0000-4000-8000-000000000993'},userId:'b',onContinue:vi.fn()}));
  await screen.findByRole('link',{name:'Ответить анонимно'});
  await act(async()=>resolveOld(entry));
  expect(screen.getByRole('link',{name:'Ответить анонимно'}).getAttribute('href')).toContain('invite='+'b'.repeat(64));
 });
 it('permits continuation when the form is unavailable and retries a failed read', async () => {
  call.mockRejectedValueOnce(new Error('Связь прервана')).mockResolvedValue(entry);
  const next=vi.fn();
  render(createElement(ConnectedSurveyStart,{api,session,userId:'a',onContinue:next}));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button',{name:'К барьерам'}));expect(next).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button',{name:'Повторить'}));
  await screen.findByRole('link',{name:'Ответить анонимно'});
  await waitFor(()=>expect(screen.queryByRole('alert')).toBeNull());
 });
 it.each([
  { status: 'closed' as const, expired: false, label: 'Ответы хранятся до' },
  { status: 'open' as const, expired: true, label: 'Срок хранения закончился' },
 ])('explains $status / expired=$expired while keeping the workshop accessible', async ({status,expired,label}) => {
  call.mockResolvedValue({...entry,invitationToken:null,survey:{...entry.survey,status,expired,canRespond:false}});
  const next=vi.fn();
  render(createElement(ConnectedSurveyStart,{api,session,userId:'participant',onContinue:next}));
  expect((await screen.findByText(/Приём ответов завершён/)).textContent).toContain(label);
  expect(screen.getByText('09.12.2026').getAttribute('datetime')).toBe('2026-12-09');
  expect(screen.queryByRole('link',{name:'Ответить анонимно'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'К барьерам'}));expect(next).toHaveBeenCalledOnce();
 });
 it('rejects leaked identity fields or small counts in launch metadata', () => {
  expect(parseWorkshopSurveyEntry(entry)).toEqual(entry);
  expect(()=>parseWorkshopSurveyEntry({...entry,responseSecret:'c'.repeat(64)})).toThrow();
  expect(()=>parseWorkshopSurveyEntry({...entry,survey:{...entry.survey,responseCount:1}})).toThrow();
  expect(()=>parseWorkshopSurveyEntry({...entry,invitationToken:null})).toThrow();
 });
 it('creates a readable receipt without putting the personal secret in its restore URL', () => {
  const receipt=createSurveyReceipt(entry.survey.id,'c'.repeat(64),'https://survey.example.test/survey.html');
  const text=surveyReceiptText(receipt);
  expect(text).toContain('Личный ключ:\n'+'c'.repeat(64));
  expect(text).toContain('https://survey.example.test/survey.html#survey='+entry.survey.id+'\n');
  expect(text).not.toMatch(/https:[^\n]*c{64}/);
  expect(text).not.toContain('responseSecret');
 });
});

// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnchor, type PracticeOccurrence } from '@domain/index';
import { makeVariant, makeVersion } from '../../packages/domain/tests/fixtures';
import type { CorpusDocument } from '../../apps/web/src/lib/corpus';
import { DocumentCardComposer } from '../../apps/web/src/components/DocumentCardComposer';
import { CardEditor } from '../../apps/web/src/components/CardEditor';
import { anchorQuote } from '../../apps/web/src/lib/workspace-domain';

const version = makeVersion([
  'Первая цитата: семье предоставляется компенсация платы за детский сад.',
  'Вторая цитата: заявление подаётся по месту жительства в регионе.',
]);
const doc: CorpusDocument = {
  entry: { id: version.documentId, regionId: '13', territory: 'Республика Мордовия',
    title: 'Региональная программа', status: 'ready', pageCount: 2, versionId: version.id, source: {} },
  version,
};
const anchor = createAnchor(version, version.blocks.map(block => ({
  blockId: block.id, start: 0, end: Array.from(block.text).length,
})));
const occurrence: PracticeOccurrence = { id: 'saved-source', documentId: version.documentId,
  versionId: version.id, anchor, reviewStatus: 'candidate' };
const props = () => ({
  doc, entry: doc.entry, selection: anchor, selected: null, occurrences: [occurrence], busy: false,
  onCreate: vi.fn(), onOpenCitation: vi.fn(), onEdit: vi.fn(), onShare: vi.fn(),
});
afterEach(cleanup);

describe('document card authorship', () => {
  it('shows every selected excerpt in full and creates a new card without a card-linking workflow', () => {
    const actions = props();
    render(createElement(DocumentCardComposer, actions));
    const composer = screen.getByRole('complementary', { name: 'Карточка по документу' });
    for (const span of anchor.spans) expect(within(composer).getByText(span.exact, { exact: true })).toBeTruthy();
    expect(composer.querySelectorAll('blockquote')).toHaveLength(2);
    expect(within(composer).queryByRole('searchbox')).toBeNull();
    expect(within(composer).queryByRole('combobox')).toBeNull();
    expect(within(composer).queryByRole('checkbox')).toBeNull();
    expect(within(composer).queryByText(/Подходящие карточки|Практики этого региона/u)).toBeNull();
    expect(within(composer).queryByRole('button', { name: /Связать|Подтвердить связь/u })).toBeNull();
    fireEvent.click(within(composer).getByRole('button', { name: 'Создать карточку' }));
    expect(actions.onCreate).toHaveBeenCalledOnce();
  });

  it('edits title and content independently of the immutable multi-excerpt source', () => {
    const onSave = vi.fn(async () => {});
    const sourceBefore = structuredClone(anchor);
    render(createElement(CardEditor, { entry: doc.entry, anchor, onSave, onClose: vi.fn(), busy: false }));
    const dialog = screen.getByRole('dialog', { name: 'Новая карточка по документу' });
    const title = within(dialog).getByRole('textbox', { name: 'Название практики' }) as HTMLInputElement;
    const content = within(dialog).getByRole('textbox', { name: 'Содержание карточки' }) as HTMLTextAreaElement;
    expect(title.value).toBe('');
    expect(content.value).toBe(anchorQuote(anchor));
    fireEvent.change(title, { target: { value: 'Моя новая карточка' } });
    fireEvent.change(content, { target: { value: 'Содержание, изложенное автором своими словами.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Сохранить карточку' }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Моя новая карточка', mechanism: 'Содержание, изложенное автором своими словами.',
    }));
    expect(anchor).toEqual(sourceBefore);
    for (const span of anchor.spans) expect(within(dialog).getByText(span.exact, { exact: true })).toBeTruthy();
  });

  it('retains saved source excerpts and opens only the selected card’s own citations', () => {
    const actions = props();
    const selected = makeVariant({ id: 'my-card', title: 'Авторская карточка', mechanism: 'Авторское содержание',
      occurrenceIds: [occurrence.id] });
    const otherSource = { ...occurrence, id: 'unrelated-source' };
    render(createElement(DocumentCardComposer, { ...actions, selection: null, selected, occurrences: [occurrence, otherSource] }));
    const composer = screen.getByRole('complementary', { name: 'Карточка по документу' });
    expect(within(composer).getByRole('article', { name: 'Сохранённая карточка' }).textContent).toContain('Авторское содержание');
    expect(composer.querySelectorAll('blockquote')).toHaveLength(2);
    expect(within(composer).getAllByRole('button', { name: /^Открыть цитату/u })).toHaveLength(1);
    fireEvent.click(within(composer).getByRole('button', { name: 'Редактировать карточку' }));
    fireEvent.click(within(composer).getByRole('button', { name: 'Открыть цитату 1' }));
    fireEvent.click(within(composer).getByRole('button', { name: 'Отправить в занятие' }));
    expect(actions.onEdit).toHaveBeenCalledOnce();
    expect(actions.onOpenCitation).toHaveBeenCalledExactlyOnceWith(occurrence);
    expect(actions.onShare).toHaveBeenCalledOnce();
    expect(within(composer).queryByRole('button', { name: /Связать|Подтвердить связь/u })).toBeNull();
  });

  it('does not create a source-based card from a mismatched edition or an empty selection', () => {
    const actions = props();
    const mounted = render(createElement(DocumentCardComposer, {
      ...actions, selection: { ...anchor, versionId: 'other-edition' },
    }));
    expect((screen.getByRole('button', { name: 'Создать карточку' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('не совпадает');
    mounted.rerender(createElement(DocumentCardComposer, { ...actions, selection: null }));
    expect((screen.getByRole('button', { name: 'Создать карточку' }) as HTMLButtonElement).disabled).toBe(true);
    expect(actions.onCreate).not.toHaveBeenCalled();
  });
});

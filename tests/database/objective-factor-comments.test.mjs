import { it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from './harness.mjs';

async function anon(db, sql, args) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role anon');
    return (await tx.query(sql, args)).rows[0].result;
  });
}
const identify = (db, name) => anon(
  db, 'select public.dw_identify($1,$2) result', [randomUUID() + '@example.test', name],
).then((result) => result.session);
const rpc = (db, user, method, args) => anon(
  db, 'select public.dw_entry_rpc($1,$2,$3::jsonb) result', [user.access_token, method, JSON.stringify(args)],
);
const failure = (call, code) => assert.rejects(call, (error) => error.code === 'P0001' && error.message === code);

it('shares optional explanations for the same correlation and territory with revision and author isolation', async () => {
  const db = await createTestDatabase({ seedCorpus: false });
  try {
    const a = await identify(db, 'Первый Участник');
    const b = await identify(db, 'Второй Участник');
    const outsider = await identify(db, 'Внешний Участник');
    const enter = (user) => rpc(db, user, 'dw_enter_workspace', { p_operation_id: randomUUID() });
    const entered = await enter(a);
    assert.equal((await enter(b)).session.id, entered.session.id);
    const scope = {
      p_session_id: entered.session.id,
      p_factor_key: 'kindergarten-p',
      p_territory_key: 'region-13',
    };
    const read = (user, update = {}) => rpc(db, user, 'dw_objective_factor_comments', { ...scope, ...update });
    const save = (user, text, revision = 0, operation = randomUUID(), update = {}) => rpc(
      db, user, 'dw_save_objective_factor_comment',
      { ...scope, p_operation_id: operation, p_expected_revision: revision, p_text: text, ...update },
    );
    assert.deepEqual((await read(a)).comments, []);
    await failure(read(outsider), 'FORBIDDEN');
    await failure(save(outsider, 'Внешний текст'), 'FORBIDDEN');
    await failure(read(a, { p_session_id: randomUUID() }), 'FORBIDDEN');
    await failure(save(a, 'Лишние данные', 0, randomUUID(), { p_author_id: b.user.id }), 'INVALID_INPUT');
    await failure(save(a, 'abc', 0, randomUUID(), { p_factor_key: 'wrong factor' }), 'INVALID_INPUT');
    await failure(save(a, '  \n'), 'INVALID_INPUT');
    await failure(save(a, 'я'.repeat(1001)), 'INVALID_INPUT');
    await assert.rejects(
      anon(db, 'select public.dw_objective_factor_comments($1,$2,$3) result', Object.values(scope)),
      (error) => error.code === '42501',
    );

    const request = randomUUID();
    const a1 = await save(a, '  Доступность садов упрощает возвращение к работе.\r\nВозможна обратная связь.  ', 0, request);
    assert.equal(a1.myRevision, 1);
    assert.deepEqual(a1.comments, [{
      id: a1.comments[0].id,
      text: 'Доступность садов упрощает возвращение к работе.\nВозможна обратная связь.',
      mine: true,
    }]);
    const b0 = await read(b);
    assert.deepEqual(b0.comments, [{ ...a1.comments[0], mine: false }]);
    assert.equal(b0.myRevision, 0);
    for (const user of [a, b]) assert(!JSON.stringify(b0).includes(user.user.id));
    assert.deepEqual((await read(b, { p_territory_key: 'region-77' })).comments, []);
    assert.deepEqual((await read(b, { p_factor_key: 'kindergarten-n' })).comments, []);

    const b1 = await save(b, 'Спрос выше там, где много молодых семей.');
    assert.equal(b1.comments.length, 2);
    assert.equal(b1.comments.find((comment) => comment.id === a1.comments[0].id).mine, false);
    await failure(save(b, 'Прежняя версия', 0), 'REVISION_CONFLICT');
    const a2 = await save(a, 'Обновлённое объяснение', 1);
    assert.equal(a2.myRevision, 2);
    assert.equal(a2.comments.find(({ mine }) => mine).id, a1.comments[0].id);
    await failure(save(a, 'Иной запрос с тем же идентификатором', 0, request), 'IDEMPOTENCY_CONFLICT');
    const replay = await save(a, '  Доступность садов упрощает возвращение к работе.\r\nВозможна обратная связь.  ', 0, request);
    assert.deepEqual(replay, a2);

    const removed = await save(a, null, 2);
    assert.equal(removed.myRevision, 3);
    assert.equal(removed.comments.length, 1);
    assert.equal(removed.comments[0].mine, false);
    await failure(save(a, 'Задержавшаяся правка', 2), 'REVISION_CONFLICT');
    const recreated = await save(a, 'Новая гипотеза', 3);
    assert.equal(recreated.myRevision, 4);
    assert.equal(recreated.comments.length, 2);
    const board = await rpc(db, b, 'dw_flipchart_updates', { p_session_id: scope.p_session_id, p_board: 'objective-v2' });
    assert.deepEqual(board.notes, []);
  } finally {
    await db.close();
  }
});

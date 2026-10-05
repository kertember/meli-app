// Runs the Supabase migrations in PGlite (Postgres in-process) with a stand-in for the parts
// of Supabase they rely on: the auth schema, the API roles and their default grants.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const MOM = '11111111-1111-1111-1111-111111111111';
const STRANGER = '22222222-2222-2222-2222-222222222222';

const SUPABASE_STANDIN = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  insert into auth.users values ('${MOM}'), ('${STRANGER}');
`;

let db;

before(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STANDIN);
  const schema = readFileSync(new URL('../supabase/migrations/20261005090000_fuzet_schema.sql', import.meta.url), 'utf8');
  await db.exec(schema);
});

/** Runs [fn] as a signed-in user, the way PostgREST does, inside a transaction rolled back after. */
async function asUser(userId, fn) {
  await db.exec('begin');
  try {
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await db.exec('set local role authenticated');
    return await fn();
  } finally {
    await db.exec('rollback');
  }
}

/** Runs [fn] as the database owner inside a transaction rolled back after. */
async function scratch(fn) {
  await db.exec('begin');
  try {
    return await fn();
  } finally {
    await db.exec('rollback');
  }
}

async function insertAs(userId, day, hour, name, note = '') {
  await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
  await db.exec('set local role authenticated');
  const { rows } = await db.query(
    'insert into public.appointments (day, hour, name, note) values ($1, $2, $3, $4) returning *',
    [day, hour, name, note],
  );
  await db.exec('reset role');
  return rows[0];
}

async function subscribe(userId, endpoint = `https://push.example/${userId}`) {
  await db.query('insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)', [
    userId, endpoint, 'p256dh-key', 'auth-secret',
  ]);
}

/** A Romanian wall-clock time as an instant. */
async function local(localTimestamp) {
  const { rows } = await db.query(`select ($1::timestamp at time zone 'Europe/Bucharest') as t`, [localTimestamp]);
  return rows[0].t;
}

async function claim(now) {
  const { rows } = await db.query('select public.meli_claim_due_notifications($1) as r', [now]);
  return rows[0].r;
}

async function due(now) {
  const { rows } = await db.query('select public.meli_notifications_due($1) as d', [now]);
  return rows[0].d;
}

test('a user sees and changes only their own appointments', async () => {
  await scratch(async () => {
    await insertAs(MOM, '2099-03-02', 10, 'Kovács Anna');
    await insertAs(STRANGER, '2099-03-02', 11, 'Idegen');
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [MOM]);
    await db.exec('set local role authenticated');
    const seen = (await db.query('select name from public.appointments')).rows.map((r) => r.name);
    assert.deepEqual(seen, ['Kovács Anna']);
    const updated = await db.query(`update public.appointments set name = 'x' where name = 'Idegen'`);
    assert.equal(updated.affectedRows, 0);
    await assert.rejects(
      db.query(`insert into public.appointments (user_id, day, hour, name) values ($1, '2099-03-02', 12, 'x')`, [STRANGER]),
      /row-level security/,
    );
  });
});

test('signed-out visitors see nothing', async () => {
  await scratch(async () => {
    await insertAs(MOM, '2099-03-02', 10, 'Kovács Anna');
    await db.exec('set local role anon');
    assert.equal((await db.query('select * from public.appointments')).rows.length, 0);
    assert.equal((await db.query('select * from public.push_subscriptions')).rows.length, 0);
  });
});

test('one student per hour, and only from 9:00 to 20:00', async () => {
  const refused = [[20, 'Még egy', /duplicate key/], [21, 'Késő', /check constraint/], [8, 'Korán', /check constraint/], [10, '   ', /check constraint/]];
  for (const [hour, name, error] of refused) {
    await scratch(async () => {
      await insertAs(MOM, '2099-03-02', 20, 'Utolsó');
      await assert.rejects(insertAs(MOM, '2099-03-02', hour, name), error);
    });
  }
});

test('a student booked less than an hour ahead gets no reminder', async () => {
  await scratch(async () => {
    const past = await insertAs(MOM, '2020-01-06', 10, 'Régi');
    const future = await insertAs(MOM, '2099-03-02', 10, 'Jövő');
    assert.notEqual(past.reminder_sent_at, null);
    assert.equal(future.reminder_sent_at, null);
  });
});

test('the app cannot touch the reminder bookkeeping', async () => {
  await asUser(MOM, async () => {
    await db.query(`insert into public.appointments (day, hour, name) values ('2099-03-02', 10, 'Anna')`);
    await db.query(`update public.appointments set reminder_sent_at = now(), user_id = $1, name = 'Anna B'`, [STRANGER]);
    const row = (await db.query('select * from public.appointments')).rows[0];
    assert.equal(row.reminder_sent_at, null);
    assert.equal(row.user_id, MOM);
    assert.equal(row.name, 'Anna B');
  });
});

test('the notification functions are for the server only', async () => {
  await asUser(MOM, async () => {
    await assert.rejects(db.query('select public.meli_claim_due_notifications()'), /permission denied/);
  });
  await asUser(MOM, async () => {
    await assert.rejects(db.query(`select public.meli_push_config('https://x', null)`), /permission denied/);
  });
  await asUser(MOM, async () => {
    await assert.rejects(db.query('select * from meli_private.settings'), /permission denied/);
  });
  await asUser(MOM, async () => {
    await assert.rejects(db.query('select * from public.evening_summaries'), /permission denied/);
  });
});

test('a reminder goes out once, an hour before the student', async () => {
  await scratch(async () => {
    await subscribe(MOM);
    const a = await insertAs(MOM, '2099-03-02', 11, 'Kovács Anna', 'dolgozat pénteken');

    assert.equal(await due(await local('2099-03-02 09:58')), false);
    assert.deepEqual((await claim(await local('2099-03-02 09:58'))).messages, []);

    assert.equal(await due(await local('2099-03-02 09:59:30')), true);
    const result = await claim(await local('2099-03-02 09:59:30'));
    assert.deepEqual(result.messages, [{
      kind: 'reminder', user_id: MOM, id: a.id, day: '2099-03-02', hour: 11,
      name: 'Kovács Anna', note: 'dolgozat pénteken', minutes_left: 61,
    }]);
    assert.deepEqual(result.subscriptions, [{
      user_id: MOM, endpoint: `https://push.example/${MOM}`, p256dh: 'p256dh-key', auth: 'auth-secret',
    }]);

    assert.equal(await due(await local('2099-03-02 10:00')), false);
    assert.deepEqual((await claim(await local('2099-03-02 10:00'))).messages, []);
  });
});

test('a missed reminder is sent late, but never after the student has arrived', async () => {
  await scratch(async () => {
    await subscribe(MOM);
    await insertAs(MOM, '2099-03-02', 11, 'Késve');
    await insertAs(MOM, '2099-03-02', 12, 'Elmaradt');
    const late = await claim(await local('2099-03-02 10:40'));
    assert.deepEqual(late.messages.map((m) => [m.name, m.minutes_left]), [['Késve', 20]]);
    assert.deepEqual((await claim(await local('2099-03-02 12:30'))).messages, []);
  });
});

test('no reminders are claimed before notifications are turned on', async () => {
  await scratch(async () => {
    await insertAs(MOM, '2099-03-02', 11, 'Kovács Anna');
    assert.equal(await due(await local('2099-03-02 10:00')), false);
    assert.deepEqual((await claim(await local('2099-03-02 10:00'))).messages, []);
    await subscribe(MOM);
    assert.equal((await claim(await local('2099-03-02 10:00'))).messages.length, 1);
  });
});

test('at 21:00 the next day is summarized once, in hour order', async () => {
  await scratch(async () => {
    await subscribe(MOM);
    await insertAs(MOM, '2099-03-03', 16, 'Németh Zita');
    await insertAs(MOM, '2099-03-03', 9, 'Lakatos Erika', 'első óra');
    await insertAs(STRANGER, '2099-03-03', 10, 'Idegen');

    assert.equal(await due(await local('2099-03-02 20:59')), false);
    assert.deepEqual((await claim(await local('2099-03-02 20:59'))).messages, []);

    assert.equal(await due(await local('2099-03-02 21:00')), true);
    const result = await claim(await local('2099-03-02 21:00'));
    assert.deepEqual(result.messages, [{
      kind: 'summary', user_id: MOM, day: '2099-03-03',
      items: [
        { hour: 9, name: 'Lakatos Erika', note: 'első óra' },
        { hour: 16, name: 'Németh Zita', note: '' },
      ],
    }]);

    assert.equal(await due(await local('2099-03-02 21:01')), false);
    assert.deepEqual((await claim(await local('2099-03-02 21:30'))).messages, []);
  });
});

test('no summary is sent when tomorrow has no students', async () => {
  await scratch(async () => {
    await subscribe(MOM);
    await insertAs(MOM, '2099-03-05', 10, 'Másnapután');
    assert.equal(await due(await local('2099-03-03 21:00')), true);
    assert.deepEqual((await claim(await local('2099-03-03 21:00'))).messages, []);
    assert.equal(await due(await local('2099-03-03 21:05')), false);
  });
});

test('a summary missed at 21:00 still goes out later that evening', async () => {
  await scratch(async () => {
    await subscribe(MOM);
    await insertAs(MOM, '2099-03-03', 9, 'Reggeli');
    assert.equal((await claim(await local('2099-03-02 23:40'))).messages.length, 1);
  });
});

test('reminder times follow the clock change', async () => {
  await scratch(async () => {
    await subscribe(MOM);
    // Summer time ends at 4:00 on 25 October 2099; a 9:00 lesson that day is at 7:00 UTC, not 6:00.
    await insertAs(MOM, '2099-10-25', 9, 'Óraátállítás');
    assert.deepEqual((await claim(new Date('2099-10-25T05:00:00Z'))).messages, []);
    const result = await claim(new Date('2099-10-25T06:00:00Z'));
    assert.deepEqual(result.messages.map((m) => [m.name, m.minutes_left]), [['Óraátállítás', 60]]);
  });
});

test('the push config keeps the first keys stored', async () => {
  await scratch(async () => {
    assert.equal((await db.query(`select public.meli_push_config('https://ref.supabase.co') as k`)).rows[0].k, null);
    const first = (await db.query(`select public.meli_push_config('https://ref.supabase.co', '{"n": 1}') as k`)).rows[0].k;
    const second = (await db.query(`select public.meli_push_config(null, '{"n": 2}') as k`)).rows[0].k;
    assert.deepEqual(first, { n: 1 });
    assert.deepEqual(second, { n: 1 });
    const url = (await db.query(`select value from meli_private.settings where key = 'project_url'`)).rows[0].value;
    assert.equal(url, 'https://ref.supabase.co');
  });
});

test('a subscription the push service dropped is forgotten', async () => {
  await scratch(async () => {
    await subscribe(MOM, 'https://push.example/gone');
    await db.query(`select public.meli_forget_push_subscription('https://push.example/gone')`);
    assert.equal((await db.query('select * from public.push_subscriptions')).rows.length, 0);
  });
});

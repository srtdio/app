// Activity push (20261028090000_inbox_push_nudge.sql):
//
//   T1. Inserting an inbox row for user A writes one realtime.messages row on
//       topic inbox:A, private, event 'inbox', whose payload carries {w} and
//       nothing else (realtime.send may add its own message id key).
//   T2. Joining inbox:A (realtime.topic = inbox:A), user A can SELECT the
//       nudge and user B cannot. The policy authorizes the topic being joined
//       (realtime.topic()), not each row's topic: that is how Realtime checks a
//       private channel join, and realtime.messages is not exposed over the
//       Data API, so there is no row-level read to test beyond the join.
//   T3. authenticated cannot INSERT into realtime.messages on inbox:A.
//   T4. The inbox insert still succeeds when the nudge fails (realtime.send
//       renamed as its owner inside a rolled-back transaction). Skipped with
//       the reason when the connecting role cannot act as that owner.
//   T5. The trigger and function exist; anon and authenticated cannot EXECUTE
//       public._inbox_push_nudge.
//   T6. Without Realtime's schema the inbox insert still succeeds (the nudge
//       fails inside its exception block).
//
// The realtime service is excluded from the local stack
// (packages/test-utils/supabase-exclude.ts). Whether realtime.messages,
// realtime.send and realtime.topic() exist anyway is read once at collection:
// T1-T4 run only when they do, T6 only when they do not. Nothing creates the
// daily realtime.messages partitions without the service, so beforeAll creates
// today's and tomorrow's as the container superuser. Everything runs through
// psql: realtime is not exposed over PostgREST.

import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupWorkspaces,
  createAdminClient,
  loadRlsEnv,
  seedUser,
  seedWorkspace,
  type RlsEnv,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../packages/schemas/src/supabase.generated';

const RLS_SUITE = process.env.RLS_SUITE === '1';

/** Run SQL as the container superuser; returns the non-empty output lines. */
function psql(dbUrl: string, sql: string): string[] {
  const out = execFileSync('psql', [dbUrl, '-At', '-q', '-v', 'ON_ERROR_STOP=1'], {
    encoding: 'utf8',
    input: sql,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** psql that is expected to fail; returns its stderr. */
function psqlError(dbUrl: string, sql: string): string {
  try {
    psql(dbUrl, sql);
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    return typeof stderr === 'string' ? stderr : String(error);
  }
  return '';
}

/** One inbox row for `userId` in `wsId`, inserted as superuser. */
function insertEntrySql(userId: string, wsId: string): string {
  return (
    'insert into public.inbox_entries ' +
    '(user_id, workspace_id, event_type, entity_type, entity_id, scope, tier, payload) ' +
    `values ('${userId}', '${wsId}', 'system', 'workspace', '${wsId}', 'everything', 'ambient', ` +
    `'{"kind":"welcome"}'::jsonb) returning 'inserted';`
  );
}

/** Count realtime.messages on `topic` as `asUser` (authenticated) with realtime.topic = `channelTopic`. */
function countAs(dbUrl: string, asUser: string, channelTopic: string, topic: string): number {
  const claims = JSON.stringify({ sub: asUser, role: 'authenticated' });
  const lines = psql(
    dbUrl,
    `begin;
set local role authenticated;
select set_config('request.jwt.claims', '${claims}', true) is not null as ok \\g /dev/null
select set_config('realtime.topic', '${channelTopic}', true) is not null as ok \\g /dev/null
select count(*) from realtime.messages where topic = '${topic}';
rollback;`,
  );
  return Number(lines[lines.length - 1]);
}

/** Whether the local stack has the Realtime objects the nudge and policy use. */
function realtimePresent(dbUrl: string): boolean {
  const [line] = psql(
    dbUrl,
    "select to_regclass('realtime.messages') is not null " +
      "and to_regprocedure('realtime.send(jsonb, text, text, boolean)') is not null " +
      "and to_regprocedure('realtime.topic()') is not null;",
  );
  return line === 't';
}

const NO_REALTIME =
  'skipped: realtime.messages / realtime.send / realtime.topic() not in the local stack';

describe.runIf(RLS_SUITE)('activity push: inbox nudge on realtime.messages', () => {
  // Read at collection (globalSetup has already started the stack).
  const realtime = RLS_SUITE ? realtimePresent(loadRlsEnv().dbUrl) : false;
  const withRealtime = (name: string): string => (realtime ? name : `${name} (${NO_REALTIME})`);
  let env: RlsEnv;
  let admin: SupabaseClient<Database>;
  let dbUrl: string;
  let userA: SeededUser;
  let userB: SeededUser;
  let ws: SeededWorkspace;

  beforeAll(async () => {
    env = loadRlsEnv();
    dbUrl = env.dbUrl;
    admin = createAdminClient(env);
    userA = await seedUser(env, admin);
    userB = await seedUser(env, admin);
    ws = await seedWorkspace(admin, userA, `push_${Date.now()}`);
    if (!realtime) return;
    // Today's and tomorrow's partitions (UTC), skipped when one already covers it.
    psql(
      dbUrl,
      `do $$
declare d date;
begin
  foreach d in array array[(now() at time zone 'utc')::date, (now() at time zone 'utc')::date + 1] loop
    begin
      execute format(
        'create table if not exists realtime.%I partition of realtime.messages for values from (%L) to (%L)',
        'messages_' || to_char(d, 'YYYY_MM_DD'), d, d + 1);
    exception when others then null;
    end;
  end loop;
end $$;`,
    );
  });

  afterAll(async () => {
    if (realtime) {
      psql(
        dbUrl,
        `delete from realtime.messages where topic in ('inbox:${userA.id}', 'inbox:${userB.id}');`,
      );
    }
    await cleanupWorkspaces(admin, [ws], [userA, userB]);
  });

  it.runIf(realtime)(
    withRealtime('T1: an inbox insert for A writes one private {w} nudge on inbox:A'),
    () => {
      const topic = `inbox:${userA.id}`;
      psql(dbUrl, `delete from realtime.messages where topic = '${topic}';`);
      expect(psql(dbUrl, insertEntrySql(userA.id, ws.id))).toEqual(['inserted']);
      const rows = psql(
        dbUrl,
        `select json_build_object('event', event, 'extension', extension, 'private', private, ` +
          `'payload', payload)::text from realtime.messages where topic = '${topic}';`,
      ).map(
        (l) =>
          JSON.parse(l) as {
            event: string;
            extension: string;
            private: boolean;
            payload: Record<string, unknown>;
          },
      );
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row === undefined) throw new Error('no nudge row');
      expect(row.event).toBe('inbox');
      expect(row.extension).toBe('broadcast');
      expect(row.private).toBe(true);
      expect(row.payload.w).toBe(ws.id);
      expect(Object.keys(row.payload).filter((k) => k !== 'id')).toEqual(['w']);
      // Nothing on B's topic.
      expect(
        psql(dbUrl, `select count(*) from realtime.messages where topic = 'inbox:${userB.id}';`),
      ).toEqual(['0']);
    },
  );

  it.runIf(realtime)(withRealtime('T2: A can SELECT the nudge; B cannot'), () => {
    const topicA = `inbox:${userA.id}`;
    expect(countAs(dbUrl, userA.id, topicA, topicA)).toBeGreaterThanOrEqual(1);
    expect(countAs(dbUrl, userB.id, topicA, topicA)).toBe(0);
  });

  it.runIf(realtime)(
    withRealtime('T3: authenticated cannot INSERT into realtime.messages on inbox:A'),
    () => {
      const topicA = `inbox:${userA.id}`;
      const claims = JSON.stringify({ sub: userA.id, role: 'authenticated' });
      const err = psqlError(
        dbUrl,
        `begin;
set local role authenticated;
select set_config('request.jwt.claims', '${claims}', true) is not null as ok \\g /dev/null
select set_config('realtime.topic', '${topicA}', true) is not null as ok \\g /dev/null
insert into realtime.messages (topic, extension, event, payload, private)
values ('${topicA}', 'broadcast', 'inbox', '{"w":"x"}'::jsonb, true);
rollback;`,
      );
      expect(err).toMatch(/row-level security|permission denied/i);
    },
  );

  it.runIf(realtime)(withRealtime('T4: the inbox insert succeeds when the nudge fails'), (ctx) => {
    const [owner = ''] = psql(
      dbUrl,
      'select pg_get_userbyid(proowner) from pg_proc ' +
        "where oid = 'realtime.send(jsonb, text, text, boolean)'::regprocedure;",
    );
    const [canAct] = psql(dbUrl, `select pg_has_role(current_user, '${owner}', 'MEMBER');`);
    if (canAct !== 't') {
      ctx.skip(`skipped: the test role cannot act as ${owner}, the owner of realtime.send`);
    }
    const lines = psql(
      dbUrl,
      `begin;
set local role "${owner}";
alter function realtime.send(jsonb, text, text, boolean) rename to send_off_for_test;
reset role;
${insertEntrySql(userA.id, ws.id)}
rollback;`,
    );
    expect(lines).toEqual(['inserted']);
  });

  it('T5: the trigger and function exist; anon and authenticated cannot EXECUTE it', () => {
    expect(
      psql(
        dbUrl,
        "select count(*) from pg_trigger where tgname = 'inbox_entries_push_ins' " +
          "and tgrelid = 'public.inbox_entries'::regclass and tgfoid = 'public._inbox_push_nudge()'::regprocedure;",
      ),
    ).toEqual(['1']);
    const lines = psql(
      dbUrl,
      `select has_function_privilege('authenticated', 'public._inbox_push_nudge()', 'execute');
select has_function_privilege('anon', 'public._inbox_push_nudge()', 'execute');`,
    );
    expect(lines).toEqual(['f', 'f']);
  });

  it.runIf(!realtime)('T6: without Realtime the inbox insert still succeeds', () => {
    expect(psql(dbUrl, insertEntrySql(userA.id, ws.id))).toEqual(['inserted']);
    expect(
      psql(
        dbUrl,
        `select count(*) from public.inbox_entries where user_id = '${userA.id}' and workspace_id = '${ws.id}';`,
      ),
    ).not.toEqual(['0']);
  });
});

import { describe, expect, it } from 'vitest';
import { CATCHUP_EVENT_TYPES, runCatchup } from './catchup-send';
import type {
  CatchupDbClient,
  CatchupEnv,
  CatchupGate,
  CatchupTickResult,
  DeliverRequest,
  Deliverer,
  DeliveryResult,
  Logger,
} from './catchup-contracts';

// runCatchup is driven against an in-memory fake of the CatchupDbClient subset
// documented in catchup-contracts.ts. The fake applies filters to seeded rows,
// records every query, and throws on anything outside the documented subset
// (or(), rpc(), single(), embedded selects, unknown tables or columns, filters
// on json columns) so misuse fails loudly. Every real collaborator (decideSlot,
// the renderer, the idempotency key, the unsubscribe token) runs unmocked; only
// the deliverer, getEmail, the clock and the logger are injected.
//
// Clock: Wed 2026-10-14 05:10Z is 10:40 in Asia/Kolkata, inside the 10:30 slot.
// Window: Tue 15:30 IST (2026-10-13T10:00Z) to Wed 10:30 IST (2026-10-14T05:00Z).

const NOW = new Date('2026-10-14T05:10:00.000Z');
const NOT_SLOT_NOW = new Date('2026-10-14T05:35:00.000Z'); // 11:05 IST
const WINDOW_START = '2026-10-13T10:00:00.000Z';
const WINDOW_END = '2026-10-14T05:00:00.000Z';
const ONE_MINUTE_BEFORE_START = '2026-10-13T09:59:00.000Z';
const IN_WINDOW = '2026-10-13T12:00:00.000Z';
const IN_WINDOW_LATER = '2026-10-13T18:00:00.000Z';
const BEFORE_WINDOW = '2026-10-10T08:00:00.000Z';
const ZONE = 'Asia/Kolkata';
const LOCAL_DATE = '2026-10-14';

const TEST_EMAIL_DOMAIN = 'example.test';

const ENV: CatchupEnv = {
  SUPABASE_URL: 'https://supabase.example.test',
  SUPABASE_SECRET_KEY: 'test-secret-key-not-real',
  RESEND_API_KEY: 'test-resend-key-not-real',
  APP_BASE_URL: 'https://app.example.test',
  CATCHUP_FROM_ADDRESS: `Sorted Test <catchup@${TEST_EMAIL_DOMAIN}>`,
  UNSUBSCRIBE_SIGNING_SECRET: 'test-unsubscribe-secret',
  CATCHUP_MODE: 'live',
};

const LIVE: CatchupGate = { mode: 'live' };

function uid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

// --- in-memory CatchupDbClient fake ------------------------------------------

type Row = Record<string, unknown>;

const SCHEMA = {
  users: [
    'id',
    'display_name',
    'designation',
    'avatar_url',
    'deleted_at',
    'timezone',
    'profile_completed_at',
    'email_opt_in',
    'username',
    'created_at',
    'updated_at',
  ],
  workspaces: [
    'id',
    'name',
    'owner_user_id',
    'plan_tier',
    'timezone',
    'week_start_day',
    'subscription_state',
    'digest_default_time',
    'key',
    'platform',
    'client_domain',
    'logo_url',
    'row_version',
    'created_at',
    'updated_at',
    'deleted_at',
  ],
  workspace_members: [
    'id',
    'workspace_id',
    'user_id',
    'role',
    'active',
    'invited_by',
    'invited_at',
    'accepted_at',
    'removed_at',
    'rejoined_at',
    'join_default_group',
  ],
  posts: [
    'id',
    'workspace_id',
    'title',
    'caption',
    'bucket_id',
    'owner_user_id',
    'platform',
    'format',
    'stage',
    'stage_entered_at',
    'approved_by',
    'approved_at',
    'target_date',
    'origin',
    'brief_id',
    'row_version',
    'created_by',
    'legacy_author_name',
    'created_at',
    'updated_at',
    'deleted_at',
  ],
  briefs: [
    'id',
    'workspace_id',
    'title',
    'objective',
    'status',
    'closed_at',
    'closed_by',
    'created_by',
    'created_via',
    'row_version',
    'created_at',
    'updated_at',
    'deleted_at',
  ],
  inbox_entries: [
    'id',
    'user_id',
    'actor_user_id',
    'workspace_id',
    'event_type',
    'entity_type',
    'entity_id',
    'scope',
    'scope_key',
    'tier',
    'payload',
    'read_at',
    'snoozed_until',
    'email_sent_at',
    'deleted_at',
    'created_at',
  ],
  chat_channels: [
    'channel_id',
    'workspace_id',
    'channel_type',
    'entity_id',
    'dm_user_a',
    'dm_user_b',
    'owner_user_id',
    'agora_group_id',
    'last_synced_at',
    'created_at',
  ],
  chat_messages: [
    'id',
    'channel_id',
    'workspace_id',
    'sender_user_id',
    'body',
    'mentions',
    'attachment_asset_ids',
    'shared_plan_ids',
    'reply_to_message_id',
    'thread_root_message_id',
    'agora_event_id',
    'created_at',
    'edited_at',
    'deleted_at',
  ],
  chat_read_cursors: [
    'channel_id',
    'user_id',
    'workspace_id',
    'last_read_message_id',
    'last_read_at',
    'updated_at',
  ],
  delivery_attempts: [
    'id',
    'workspace_id',
    'user_id',
    'channel',
    'template_key',
    'provider',
    'provider_message_id',
    'status',
    'sent_at',
    'error',
    'created_at',
  ],
} as const;

type TableName = keyof typeof SCHEMA;

const JSON_COLUMNS: Partial<Record<TableName, readonly string[]>> = {
  inbox_entries: ['payload'],
  chat_messages: ['mentions'],
};

type Tables = Record<TableName, Row[]>;

type Filter =
  | { op: 'eq' | 'neq' | 'gte' | 'gt' | 'lt' | 'lte'; col: string; value: unknown }
  | { op: 'in'; col: string; values: readonly unknown[] }
  | { op: 'is_null'; col: string }
  | { op: 'not_null'; col: string };

interface RecordedQuery {
  table: TableName;
  kind: 'select' | 'insert' | 'update';
  columns: string;
  filters: Filter[];
}

interface FakeResult {
  data: Row[] | null;
  error: null;
  count: number | null;
  status: number;
  statusText: string;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function norm(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') return ISO_RE.test(v) ? Date.parse(v) : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
}

function compare(a: unknown, b: unknown): number | null {
  const x = norm(a);
  const y = norm(b);
  if (x === null || y === null) return null;
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

function matches(row: Row, f: Filter): boolean {
  const v = row[f.col];
  switch (f.op) {
    case 'is_null':
      return v === null || v === undefined;
    case 'not_null':
      return v !== null && v !== undefined;
    case 'in':
      return norm(v) !== null && f.values.some((x) => norm(x) === norm(v));
    case 'eq':
      return norm(v) !== null && norm(v) === norm(f.value);
    case 'neq':
      return norm(v) !== null && norm(v) !== norm(f.value);
    default: {
      const c = compare(v, f.value);
      if (c === null) return false;
      if (f.op === 'gte') return c >= 0;
      if (f.op === 'gt') return c > 0;
      if (f.op === 'lt') return c < 0;
      return c <= 0;
    }
  }
}

class FakeDb {
  readonly queries: RecordedQuery[] = [];
  readonly violations: string[] = [];

  constructor(readonly tables: Tables) {}

  fail(message: string): never {
    this.violations.push(message);
    throw new Error(`CatchupDbClient fake: ${message}`);
  }

  assertTable(table: string): TableName {
    if (!(table in SCHEMA)) this.fail(`unknown table "${table}"`);
    return table as TableName;
  }

  assertColumn(table: TableName, col: string): void {
    const cols: readonly string[] = SCHEMA[table];
    if (!cols.includes(col)) this.fail(`unknown column ${table}.${col}`);
  }

  from(table: string): FakeFrom {
    return new FakeFrom(this, this.assertTable(table));
  }

  rpc(): never {
    return this.fail('rpc() is not part of CatchupDbClient');
  }

  asClient(): CatchupDbClient {
    return this as unknown as CatchupDbClient;
  }
}

class FakeFrom {
  constructor(
    private readonly db: FakeDb,
    private readonly table: TableName,
  ) {}

  select(columns = '*', opts?: { count?: string; head?: boolean }): FakeQuery {
    return new FakeQuery(this.db, this.table, 'select', columns, opts ?? {}, null);
  }

  insert(rows: Row | Row[]): FakeQuery {
    return new FakeQuery(
      this.db,
      this.table,
      'insert',
      '',
      {},
      Array.isArray(rows) ? rows : [rows],
    );
  }

  update(patch: Row): FakeQuery {
    return new FakeQuery(this.db, this.table, 'update', '', {}, [patch]);
  }

  upsert(): never {
    return this.db.fail('upsert() is not part of CatchupDbClient');
  }

  delete(): never {
    return this.db.fail('delete() is not part of CatchupDbClient');
  }
}

class FakeQuery implements PromiseLike<FakeResult> {
  private readonly filters: Filter[] = [];
  private readonly orders: { col: string; ascending: boolean }[] = [];
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private limitN: number | null = null;
  private readonly selected: { key: string; col: string }[] | null;

  constructor(
    private readonly db: FakeDb,
    private readonly table: TableName,
    private readonly kind: 'select' | 'insert' | 'update',
    private readonly columns: string,
    private readonly opts: { count?: string; head?: boolean },
    private readonly payload: Row[] | null,
  ) {
    this.selected = kind === 'select' ? this.parseColumns(columns) : null;
    if (payload)
      for (const row of payload) for (const col of Object.keys(row)) db.assertColumn(table, col);
  }

  private parseColumns(columns: string): { key: string; col: string }[] | null {
    const trimmed = columns.trim();
    if (trimmed === '*' || trimmed === '') return null;
    return trimmed.split(',').map((raw) => {
      const part = raw.trim();
      if (/[()!]/.test(part)) this.db.fail(`embedded or hinted select "${part}" on ${this.table}`);
      const [alias, col] = part.includes(':') ? part.split(':') : [part, part];
      const key = (alias ?? part).trim();
      const name = (col ?? part).trim();
      this.db.assertColumn(this.table, name);
      return { key, col: name };
    });
  }

  private filterColumn(col: string): void {
    this.db.assertColumn(this.table, col);
    if (JSON_COLUMNS[this.table]?.includes(col)) {
      this.db.fail(`filter on json column ${this.table}.${col}`);
    }
  }

  private push(f: Filter): this {
    this.filterColumn(f.col);
    this.filters.push(f);
    return this;
  }

  eq(col: string, value: unknown): this {
    return this.push({ op: 'eq', col, value });
  }
  neq(col: string, value: unknown): this {
    return this.push({ op: 'neq', col, value });
  }
  gte(col: string, value: unknown): this {
    return this.push({ op: 'gte', col, value });
  }
  gt(col: string, value: unknown): this {
    return this.push({ op: 'gt', col, value });
  }
  lt(col: string, value: unknown): this {
    return this.push({ op: 'lt', col, value });
  }
  lte(col: string, value: unknown): this {
    return this.push({ op: 'lte', col, value });
  }
  in(col: string, values: readonly unknown[]): this {
    return this.push({ op: 'in', col, values: [...values] });
  }
  is(col: string, value: unknown): this {
    if (value !== null)
      this.db.fail(`is(${col}, ${String(value)}): only is(col, null) is supported`);
    return this.push({ op: 'is_null', col });
  }
  not(col: string, operator: string, value: unknown): this {
    if (operator !== 'is' || value !== null) {
      this.db.fail(`not(${col}, ${operator}, ...): only not(col, 'is', null) is supported`);
    }
    return this.push({ op: 'not_null', col });
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.db.assertColumn(this.table, col);
    this.orders.push({ col, ascending: opts?.ascending ?? true });
    return this;
  }
  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  returns(): this {
    return this;
  }

  or(): never {
    return this.db.fail('or() is not part of CatchupDbClient');
  }
  single(): never {
    return this.db.fail('single() is not part of CatchupDbClient');
  }
  maybeSingle(): never {
    return this.db.fail('maybeSingle() is not part of CatchupDbClient');
  }
  filter(): never {
    return this.db.fail('filter() is not part of CatchupDbClient');
  }
  match(): never {
    return this.db.fail('match() is not part of CatchupDbClient');
  }
  like(): never {
    return this.db.fail('like() is not part of CatchupDbClient');
  }
  ilike(): never {
    return this.db.fail('ilike() is not part of CatchupDbClient');
  }
  contains(): never {
    return this.db.fail('contains() is not part of CatchupDbClient');
  }
  csv(): never {
    return this.db.fail('csv() is not part of CatchupDbClient');
  }

  then<T1 = FakeResult, T2 = never>(
    onfulfilled?: ((value: FakeResult) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(onfulfilled, onrejected);
  }

  private execute(): FakeResult {
    this.db.queries.push({
      table: this.table,
      kind: this.kind,
      columns: this.columns,
      filters: [...this.filters],
    });
    const rows = this.db.tables[this.table];
    const ok = (data: Row[] | null, count: number | null): FakeResult => ({
      data,
      error: null,
      count,
      status: 200,
      statusText: 'OK',
    });

    if (this.kind === 'insert') {
      for (const row of this.payload ?? []) rows.push({ ...row });
      return ok(null, null);
    }
    const matched = rows.filter((row) => this.filters.every((f) => matches(row, f)));
    if (this.kind === 'update') {
      const patch = this.payload?.[0] ?? {};
      for (const row of matched) Object.assign(row, patch);
      return ok(null, null);
    }

    const sorted = [...matched].sort((a, b) => {
      for (const o of this.orders) {
        const av = a[o.col];
        const bv = b[o.col];
        const an = av === null || av === undefined;
        const bn = bv === null || bv === undefined;
        if (an || bn) {
          if (an && bn) continue;
          // Postgres: NULLS LAST for ascending, NULLS FIRST for descending.
          return (an ? 1 : -1) * (o.ascending ? 1 : -1);
        }
        const c = compare(av, bv) ?? 0;
        if (c !== 0) return o.ascending ? c : -c;
      }
      return 0;
    });
    let window = sorted;
    if (this.rangeFrom !== null && this.rangeTo !== null) {
      window = window.slice(this.rangeFrom, this.rangeTo + 1);
    }
    if (this.limitN !== null) window = window.slice(0, this.limitN);
    const count = this.opts.count ? matched.length : null;
    if (this.opts.head) return ok(null, count);
    const projected = window.map((row) => {
      if (!this.selected) return { ...row };
      const out: Row = {};
      for (const { key, col } of this.selected) out[key] = row[col] ?? null;
      return out;
    });
    return ok(projected, count);
  }
}

// --- world builder ------------------------------------------------------------

type Role = 'owner' | 'admin' | 'agency' | 'client';
type Stage = 'draft' | 'review' | 'approved' | 'parked' | 'rejected';

class World {
  readonly tables: Tables = {
    users: [],
    workspaces: [],
    workspace_members: [],
    posts: [],
    briefs: [],
    inbox_entries: [],
    chat_channels: [],
    chat_messages: [],
    chat_read_cursors: [],
    delivery_attempts: [],
  };
  readonly emails = new Map<string, string>();
  private seq = 1000;

  private next(): string {
    this.seq += 1;
    return uid(this.seq);
  }

  user(
    id: string,
    name: string,
    opts: { timezone?: string | null; optIn?: boolean; email?: string | null } = {},
  ): string {
    this.tables.users.push({
      id,
      display_name: name,
      timezone: opts.timezone === undefined ? ZONE : opts.timezone,
      email_opt_in: opts.optIn ?? true,
      deleted_at: null,
      created_at: BEFORE_WINDOW,
    });
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '.');
    if (opts.email !== null) this.emails.set(id, opts.email ?? `${slug}@${TEST_EMAIL_DOMAIN}`);
    return id;
  }

  workspace(id: string, name: string, timezone: string | null = ZONE): string {
    this.tables.workspaces.push({
      id,
      name,
      timezone,
      platform: 'linkedin',
      deleted_at: null,
      created_at: BEFORE_WINDOW,
    });
    return id;
  }

  member(
    workspaceId: string,
    userId: string,
    role: Role,
    opts: { active?: boolean; removedAt?: string | null } = {},
  ): void {
    this.tables.workspace_members.push({
      id: this.next(),
      workspace_id: workspaceId,
      user_id: userId,
      role,
      active: opts.active ?? true,
      removed_at: opts.removedAt ?? null,
      invited_at: BEFORE_WINDOW,
      accepted_at: BEFORE_WINDOW,
    });
  }

  post(workspaceId: string, title: string, stage: Stage, enteredAt = BEFORE_WINDOW): string {
    const id = this.next();
    this.tables.posts.push({
      id,
      workspace_id: workspaceId,
      title,
      stage,
      stage_entered_at: enteredAt,
      platform: 'linkedin',
      format: 'text',
      created_at: BEFORE_WINDOW,
      deleted_at: null,
    });
    return id;
  }

  brief(workspaceId: string, title: string): string {
    const id = this.next();
    this.tables.briefs.push({
      id,
      workspace_id: workspaceId,
      title,
      objective: 'Test objective',
      status: 'open',
      created_at: IN_WINDOW,
      deleted_at: null,
    });
    return id;
  }

  entry(
    userId: string,
    workspaceId: string,
    eventType: string,
    entity: { type: 'post' | 'brief'; id: string },
    opts: {
      createdAt?: string;
      actor?: string | null;
      payload?: Row;
      readAt?: string | null;
      snoozedUntil?: string | null;
      deletedAt?: string | null;
      emailSentAt?: string | null;
    } = {},
  ): string {
    const id = this.next();
    this.tables.inbox_entries.push({
      id,
      user_id: userId,
      actor_user_id: opts.actor ?? null,
      workspace_id: workspaceId,
      event_type: eventType,
      entity_type: entity.type,
      entity_id: entity.id,
      scope: entity.type === 'post' ? 'posts' : 'briefs',
      scope_key: null,
      tier: 'active',
      payload: opts.payload ?? {},
      read_at: opts.readAt ?? null,
      snoozed_until: opts.snoozedUntil ?? null,
      email_sent_at: opts.emailSentAt ?? null,
      deleted_at: opts.deletedAt ?? null,
      created_at: opts.createdAt ?? IN_WINDOW,
    });
    return id;
  }

  comment(
    userId: string,
    workspaceId: string,
    postId: string,
    opts: Parameters<World['entry']>[4] = {},
  ): string {
    return this.entry(
      userId,
      workspaceId,
      'comment',
      { type: 'post', id: postId },
      {
        ...opts,
        payload: {
          comment_id: this.next(),
          entity_type: 'post',
          entity_id: postId,
          author_user_id: opts.actor ?? null,
          resolved: false,
        },
      },
    );
  }

  approved(userId: string, workspaceId: string, postId: string, createdAt = IN_WINDOW): string {
    return this.entry(
      userId,
      workspaceId,
      'stage_change',
      { type: 'post', id: postId },
      { createdAt, payload: { post_id: postId, from_stage: 'review', to_stage: 'approved' } },
    );
  }

  channel(row: {
    channelId: string;
    workspaceId: string;
    type: 'dm' | 'group';
    a?: string;
    b?: string;
    groupId?: string;
  }): string {
    const [lo, hi] = row.a && row.b ? [row.a, row.b].sort() : [null, null];
    this.tables.chat_channels.push({
      channel_id: row.channelId,
      workspace_id: row.workspaceId,
      channel_type: row.type,
      entity_id: row.groupId ?? null,
      dm_user_a: lo ?? null,
      dm_user_b: hi ?? null,
      owner_user_id: null,
      created_at: BEFORE_WINDOW,
    });
    return row.channelId;
  }

  dm(workspaceId: string, a: string, b: string): string {
    const [lo, hi] = [a, b].sort();
    return this.channel({
      channelId: `dm__${workspaceId}__${lo ?? a}__${hi ?? b}`,
      workspaceId,
      type: 'dm',
      a,
      b,
    });
  }

  message(
    channelId: string,
    workspaceId: string,
    sender: string,
    body: string,
    createdAt: string,
  ): string {
    const id = this.next();
    this.tables.chat_messages.push({
      id,
      channel_id: channelId,
      workspace_id: workspaceId,
      sender_user_id: sender,
      body,
      mentions: null,
      created_at: createdAt,
      edited_at: null,
      deleted_at: null,
    });
    return id;
  }

  cursor(channelId: string, workspaceId: string, userId: string, lastReadAt: string): void {
    this.tables.chat_read_cursors.push({
      channel_id: channelId,
      user_id: userId,
      workspace_id: workspaceId,
      last_read_message_id: null,
      last_read_at: lastReadAt,
      updated_at: lastReadAt,
    });
  }
}

// --- injected fakes and the run helper ------------------------------------------

interface LogLine {
  level: string;
  msg: string;
  context?: Record<string, unknown>;
}

function makeLog(lines: LogLine[]): Logger {
  const at =
    (level: string) =>
    (msg: string, context?: Record<string, unknown>): void => {
      lines.push(context === undefined ? { level, msg } : { level, msg, context });
    };
  return {
    setTraceId: () => undefined,
    clearTraceId: () => undefined,
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
}

interface RunOutcome {
  result: CatchupTickResult;
  deliveries: DeliverRequest[];
  db: FakeDb;
  logs: LogLine[];
}

async function run(
  world: World,
  opts: { gate?: CatchupGate; now?: Date; failDelivery?: boolean } = {},
): Promise<RunOutcome> {
  const db = new FakeDb(world.tables);
  const deliveries: DeliverRequest[] = [];
  const logs: LogLine[] = [];
  const deliverer: Deliverer = {
    deliver: (req: DeliverRequest): Promise<DeliveryResult> => {
      deliveries.push(req);
      return Promise.resolve(
        opts.failDelivery
          ? { ok: false, error: 'test provider failure' }
          : { ok: true, providerMessageId: `test-msg-${deliveries.length}` },
      );
    },
  };
  const result = await runCatchup({
    client: db.asClient(),
    env: ENV,
    gate: opts.gate ?? LIVE,
    deliverer,
    getEmail: (userId: string) => Promise.resolve(world.emails.get(userId) ?? null),
    now: opts.now ?? NOW,
    log: makeLog(logs),
  });
  expect(db.violations).toEqual([]);
  return { result, deliveries, db, logs };
}

function content(req: DeliverRequest): string {
  const { subject, html, text } = req.email.rendered;
  return [subject, html, text, JSON.stringify(req)].join('\n');
}

function renderedBody(req: DeliverRequest): string {
  const { subject, html, text } = req.email.rendered;
  return [subject, html, text].join('\n');
}

function deliveriesFor(out: RunOutcome, userId: string, workspaceId?: string): DeliverRequest[] {
  return out.deliveries.filter(
    (d) => d.userId === userId && (workspaceId === undefined || d.workspaceId === workspaceId),
  );
}

function only(out: RunOutcome, userId: string, workspaceId: string): DeliverRequest {
  const found = deliveriesFor(out, userId, workspaceId);
  expect(found).toHaveLength(1);
  const [req] = found;
  if (!req) throw new Error('missing delivery');
  return req;
}

function filtersOn(q: RecordedQuery, col: string): Filter[] {
  return q.filters.filter((f) => f.col === col);
}

function scopedToIds(q: RecordedQuery, col: string, allowed: ReadonlySet<string>): boolean {
  return filtersOn(q, col).some(
    (f) =>
      (f.op === 'eq' && typeof f.value === 'string' && allowed.has(f.value)) ||
      (f.op === 'in' && f.values.every((v) => typeof v === 'string' && allowed.has(v))),
  );
}

function hasUserFilter(q: RecordedQuery): boolean {
  return filtersOn(q, 'user_id').some((f) => f.op === 'eq' || f.op === 'in');
}

function hasCreatedAtBounds(q: RecordedQuery): boolean {
  const created = filtersOn(q, 'created_at');
  return (
    created.some((f) => f.op === 'gte' || f.op === 'gt') &&
    created.some((f) => f.op === 'lt' || f.op === 'lte')
  );
}

function excludesDrafts(q: RecordedQuery): boolean {
  return filtersOn(q, 'stage').some(
    (f) =>
      (f.op === 'neq' && f.value === 'draft') ||
      (f.op === 'in' && f.values.length > 0 && !f.values.includes('draft')) ||
      (f.op === 'eq' && f.value !== 'draft'),
  );
}

function hasWorkspaceFilter(q: RecordedQuery): boolean {
  return filtersOn(q, 'workspace_id').some((f) => f.op === 'eq' || f.op === 'in');
}

function selects(out: RunOutcome, table: TableName): RecordedQuery[] {
  return out.db.queries.filter((q) => q.table === table && q.kind === 'select');
}

// --- fixed ids ------------------------------------------------------------------

const A = uid(1);
const B = uid(2);
const X = uid(3);
const Y = uid(4);
const C = uid(5);
const D = uid(6);
const W1 = uid(101);
const W2 = uid(102);
const W3 = uid(103);
const W4 = uid(104);
const W5 = uid(105);

// --- tests ----------------------------------------------------------------------

describe('CATCHUP_EVENT_TYPES', () => {
  it('is a non-empty readonly list that leaves out the deletion events', () => {
    expect(CATCHUP_EVENT_TYPES.length).toBeGreaterThan(0);
    expect(CATCHUP_EVENT_TYPES).toContain('comment');
    expect(CATCHUP_EVENT_TYPES).not.toContain('post_deleted');
    expect(CATCHUP_EVENT_TYPES).not.toContain('assets_deleted');
  });
});

describe('runCatchup: tenant isolation', () => {
  function isolationWorld(): World {
    const w = new World();
    w.user(A, 'Anna Client');
    w.user(B, 'Bruno Agency');
    w.user(X, 'Xavier Alphateam');
    w.user(Y, 'Yolanda Betateam');
    w.workspace(W1, 'Alphaworks Wone');
    w.workspace(W2, 'Betacorp Wtwo');
    w.workspace(W3, 'Gammaco Wthree');
    w.workspace(W4, 'Deltaco Wfour');
    w.member(W1, A, 'client');
    w.member(W1, X, 'agency');
    w.member(W2, B, 'agency');
    w.member(W2, Y, 'client');
    w.member(W3, A, 'client', { active: false });
    w.member(W4, A, 'client', { removedAt: BEFORE_WINDOW });

    const alphaReview = w.post(W1, 'Alpha review post', 'review');
    const alphaApproved = w.post(W1, 'Alpha approved post', 'approved');
    const betaReview = w.post(W2, 'Beta review post', 'review');
    const betaApproved = w.post(W2, 'Beta approved post', 'approved');
    const betaBrief = w.brief(W2, 'Beta brief');
    const gammaReview = w.post(W3, 'Gamma review post', 'review');
    const deltaReview = w.post(W4, 'Delta review post', 'review');

    w.comment(A, W1, alphaReview, { actor: X });
    w.approved(A, W1, alphaApproved);
    w.comment(B, W2, betaReview, { actor: Y });
    w.approved(B, W2, betaApproved);
    w.entry(
      B,
      W2,
      'brief_created',
      { type: 'brief', id: betaBrief },
      { actor: Y, payload: { brief_id: betaBrief, title: 'Beta brief', created_by: Y } },
    );
    // A has entries pointing at workspaces A is not an active member of.
    w.comment(A, W2, betaReview, { actor: Y });
    w.comment(A, W3, gammaReview, { actor: X });
    w.comment(A, W4, deltaReview, { actor: X });
    return w;
  }

  const W1_TOKENS = [
    'Alphaworks Wone',
    'Alpha review post',
    'Alpha approved post',
    'Xavier Alphateam',
  ];
  const OTHER_TOKENS_FOR_A = [
    'Betacorp Wtwo',
    'Beta review post',
    'Beta approved post',
    'Beta brief',
    'Yolanda Betateam',
    'Gammaco Wthree',
    'Gamma review post',
    'Deltaco Wfour',
    'Delta review post',
  ];

  it('emails A only about W1 and B only about W2, with no cross-tenant content', async () => {
    const out = await run(isolationWorld());

    const a = only(out, A, W1);
    const b = only(out, B, W2);
    expect(deliveriesFor(out, A)).toHaveLength(1);
    expect(deliveriesFor(out, B)).toHaveLength(1);
    expect(out.deliveries).toHaveLength(2);

    const aBody = content(a);
    expect(renderedBody(a)).toContain('Alpha review post');
    for (const token of OTHER_TOKENS_FOR_A) expect(aBody).not.toContain(token);

    const bBody = content(b);
    expect(renderedBody(b)).toContain('Beta review post');
    for (const token of W1_TOKENS) expect(bBody).not.toContain(token);
    for (const token of [
      'Gammaco Wthree',
      'Gamma review post',
      'Deltaco Wfour',
      'Delta review post',
    ]) {
      expect(bBody).not.toContain(token);
    }

    const aW1Entries = new Set(
      out.db.tables.inbox_entries
        .filter((e) => e.user_id === A && e.workspace_id === W1)
        .map((e) => e.id),
    );
    for (const id of a.entryIds) expect(aW1Entries.has(id)).toBe(true);
    const bEntries = new Set(
      out.db.tables.inbox_entries.filter((e) => e.user_id === B).map((e) => e.id),
    );
    for (const id of b.entryIds) expect(bEntries.has(id)).toBe(true);
  });

  it('never emails a user about a workspace they are not an active member of', async () => {
    const out = await run(isolationWorld());
    expect(deliveriesFor(out, A, W2)).toHaveLength(0);
    expect(deliveriesFor(out, A, W3)).toHaveLength(0);
    expect(deliveriesFor(out, A, W4)).toHaveLength(0);
  });

  it('scopes every inbox_entries read and every posts read', async () => {
    const out = await run(isolationWorld());
    const inbox = selects(out, 'inbox_entries');
    expect(inbox.length).toBeGreaterThan(0);
    for (const q of inbox) expect(hasUserFilter(q) || hasCreatedAtBounds(q)).toBe(true);

    const posts = selects(out, 'posts');
    expect(posts.length).toBeGreaterThan(0);
    for (const q of posts) {
      expect(excludesDrafts(q)).toBe(true);
      expect(hasWorkspaceFilter(q)).toBe(true);
    }
  });
});

describe('runCatchup: drafts', () => {
  it('never shows a draft title to a client, but lists posts in review', async () => {
    const w = new World();
    w.user(A, 'Anna Client');
    w.user(X, 'Xavier Alphateam');
    w.workspace(W1, 'Alphaworks Wone');
    w.member(W1, A, 'client');
    w.member(W1, X, 'agency');
    const review = w.post(W1, 'Alpha review post', 'review');
    const draft = w.post(W1, 'Alpha hidden draft', 'draft');
    w.comment(A, W1, draft, { actor: X });
    w.entry(
      A,
      W1,
      'stage_change',
      { type: 'post', id: draft },
      { payload: { post_id: draft, from_stage: 'review', to_stage: 'draft' } },
    );
    w.comment(A, W1, review, { actor: X });

    const out = await run(w);
    for (const req of out.deliveries) expect(content(req)).not.toContain('Alpha hidden draft');
    const a = only(out, A, W1);
    expect(renderedBody(a)).toContain('Alpha review post');
  });
});

describe('runCatchup: opt-out', () => {
  it('sends nothing to a user with email_opt_in=false', async () => {
    const w = new World();
    w.user(A, 'Anna Client', { optIn: false });
    w.user(C, 'Cora Client');
    w.workspace(W1, 'Alphaworks Wone');
    w.member(W1, A, 'client');
    w.member(W1, C, 'client');
    const post = w.post(W1, 'Alpha approved post', 'approved');
    w.comment(A, W1, post);
    w.approved(A, W1, post);
    w.comment(C, W1, post);

    const out = await run(w);
    expect(deliveriesFor(out, A)).toHaveLength(0);
    expect(deliveriesFor(out, C)).toHaveLength(1);
  });
});

describe('runCatchup: unread only', () => {
  it('includes unread and expired-snooze entries, excludes read, deleted and snoozed ones', async () => {
    const w = new World();
    w.user(A, 'Anna Client');
    w.user(D, 'Dora Client');
    w.workspace(W1, 'Alphaworks Wone');
    w.member(W1, A, 'client');
    w.member(W1, D, 'client');
    const post = w.post(W1, 'Alpha approved post', 'approved');

    const plain = w.comment(A, W1, post);
    const snoozedPast = w.comment(A, W1, post, { snoozedUntil: '2026-10-14T04:00:00.000Z' });
    const read = w.comment(A, W1, post, { readAt: IN_WINDOW_LATER });
    const deleted = w.comment(A, W1, post, { deletedAt: IN_WINDOW_LATER });
    const snoozedFuture = w.comment(A, W1, post, { snoozedUntil: '2026-10-15T04:00:00.000Z' });

    w.comment(D, W1, post, { readAt: IN_WINDOW_LATER });
    w.comment(D, W1, post, { deletedAt: IN_WINDOW_LATER });
    w.comment(D, W1, post, { snoozedUntil: '2026-10-15T04:00:00.000Z' });

    const out = await run(w);
    const a = only(out, A, W1);
    expect(a.entryIds).toContain(plain);
    expect(a.entryIds).toContain(snoozedPast);
    expect(a.entryIds).not.toContain(read);
    expect(a.entryIds).not.toContain(deleted);
    expect(a.entryIds).not.toContain(snoozedFuture);
    expect(deliveriesFor(out, D)).toHaveLength(0);
  });
});

describe('runCatchup: window bounds', () => {
  it('uses the half-open window [previous slot, this slot)', async () => {
    const w = new World();
    w.user(A, 'Anna Client');
    w.user(D, 'Dora Client');
    w.workspace(W1, 'Alphaworks Wone');
    w.member(W1, A, 'client');
    w.member(W1, D, 'client');
    const post = w.post(W1, 'Alpha approved post', 'approved');

    const atStart = w.comment(A, W1, post, { createdAt: WINDOW_START });
    const middle = w.comment(A, W1, post, { createdAt: IN_WINDOW });
    const atEnd = w.comment(A, W1, post, { createdAt: WINDOW_END });
    const beforeStart = w.comment(A, W1, post, { createdAt: ONE_MINUTE_BEFORE_START });

    w.comment(D, W1, post, { createdAt: ONE_MINUTE_BEFORE_START });
    w.comment(D, W1, post, { createdAt: WINDOW_END });

    const out = await run(w);
    const a = only(out, A, W1);
    expect(a.entryIds).toContain(atStart);
    expect(a.entryIds).toContain(middle);
    expect(a.entryIds).not.toContain(atEnd);
    expect(a.entryIds).not.toContain(beforeStart);
    expect(deliveriesFor(out, D)).toHaveLength(0);
    for (const req of out.deliveries) expect(req.entryIds).not.toContain(beforeStart);
  });
});

describe('runCatchup: triggers', () => {
  function baseWorld(): World {
    const w = new World();
    w.user(A, 'Anna Client');
    w.user(X, 'Xavier Alphateam');
    w.workspace(W1, 'Alphaworks Wone');
    w.member(W1, A, 'client');
    w.member(W1, X, 'agency');
    w.post(W1, 'Alpha review post', 'review');
    w.post(W1, 'Alpha older review post', 'review', '2026-10-01T05:00:00.000Z');
    return w;
  }

  it('does not email when the only content is posts waiting in review', async () => {
    const out = await run(baseWorld());
    expect(out.deliveries).toHaveLength(0);
    expect(out.result.sent).toBe(0);
  });

  it('emails for an unread DM in the window alone, but not the sender', async () => {
    const w = baseWorld();
    const ch = w.dm(W1, A, X);
    w.message(ch, W1, X, 'Hello from Xavier', IN_WINDOW);

    const out = await run(w);
    const a = only(out, A, W1);
    expect(a.entryIds).toHaveLength(0);
    expect(renderedBody(a)).toContain('Hello from Xavier');
    expect(deliveriesFor(out, X)).toHaveLength(0);
    expect(out.deliveries).toHaveLength(1);
  });

  it('counts DM messages after the read cursor only', async () => {
    const w = baseWorld();
    const ch = w.dm(W1, A, X);
    w.message(ch, W1, X, 'Already read note', IN_WINDOW);
    w.cursor(ch, W1, A, IN_WINDOW_LATER);

    const out = await run(w);
    expect(out.deliveries).toHaveLength(0);
  });

  it('counts a DM at exactly window.start with no read cursor, alone, as one unread', async () => {
    const w = baseWorld();
    const ch = w.dm(W1, A, X);
    w.message(ch, W1, X, 'Before the window', ONE_MINUTE_BEFORE_START);
    w.message(ch, W1, X, 'Right at the start', WINDOW_START);

    const out = await run(w);
    const a = only(out, A, W1);
    expect(a.entryIds).toHaveLength(0);
    const body = renderedBody(a);
    expect(body).toContain('Right at the start');
    expect(body).toContain('1 new message');
    expect(body).not.toContain('2 new messages');
    expect(out.deliveries).toHaveLength(1);
  });

  it('does not count a DM at exactly window.end with no read cursor', async () => {
    const w = baseWorld();
    const ch = w.dm(W1, A, X);
    w.message(ch, W1, X, 'Right at the end', WINDOW_END);

    const out = await run(w);
    expect(out.deliveries).toHaveLength(0);
  });

  it('ignores group channel messages', async () => {
    const w = baseWorld();
    const groupId = uid(900);
    const ch = w.channel({
      channelId: `group__${W1}__${groupId}`,
      workspaceId: W1,
      type: 'group',
      groupId,
    });
    w.message(ch, W1, X, 'Group hello', IN_WINDOW);

    const out = await run(w);
    expect(out.deliveries).toHaveLength(0);
  });

  it('ignores the recipient own DM messages', async () => {
    const w = baseWorld();
    const ch = w.dm(W1, A, X);
    w.message(ch, W1, A, 'Note from Anna', IN_WINDOW);

    const out = await run(w);
    expect(deliveriesFor(out, A)).toHaveLength(0);
  });
});

describe('runCatchup: trial gate', () => {
  it('emails only trial users and never reads other users entries', async () => {
    const w = new World();
    w.user(A, 'Anna Client');
    w.user(B, 'Bruno Agency');
    w.workspace(W1, 'Alphaworks Wone');
    w.workspace(W2, 'Betacorp Wtwo');
    w.member(W1, A, 'owner');
    w.member(W2, B, 'owner');
    const alpha = w.post(W1, 'Alpha approved post', 'approved');
    const beta = w.post(W2, 'Beta approved post', 'approved');
    w.comment(A, W1, alpha);
    w.approved(A, W1, alpha);
    w.comment(B, W2, beta);
    w.approved(B, W2, beta);

    const trial = new Set([A]);
    const out = await run(w, { gate: { mode: 'trial', userIds: trial } });
    expect(out.deliveries.map((d) => d.userId)).toEqual([A]);

    const inbox = selects(out, 'inbox_entries');
    expect(inbox.length).toBeGreaterThan(0);
    for (const q of inbox) expect(scopedToIds(q, 'user_id', trial)).toBe(true);
    for (const q of selects(out, 'users')) expect(scopedToIds(q, 'id', trial)).toBe(true);
  });
});

describe('runCatchup: one email per user per workspace per slot', () => {
  it('batches all entries into one delivery with the slot idempotency key', async () => {
    const w = new World();
    w.user(A, 'Anna Client');
    w.user(X, 'Xavier Alphateam');
    w.workspace(W1, 'Alphaworks Wone');
    w.workspace(W2, 'Betacorp Wtwo');
    w.member(W1, A, 'client');
    w.member(W1, X, 'agency');
    w.member(W2, A, 'agency');
    const review = w.post(W1, 'Alpha review post', 'review');
    const approvedPost = w.post(W1, 'Alpha approved post', 'approved');
    const beta = w.post(W2, 'Beta approved post', 'approved');
    const e1 = w.comment(A, W1, review, { actor: X });
    const e2 = w.comment(A, W1, approvedPost, { actor: X, createdAt: IN_WINDOW_LATER });
    const e3 = w.approved(A, W1, approvedPost);
    const e4 = w.comment(A, W2, beta);

    const out = await run(w);
    expect(out.deliveries).toHaveLength(2);
    expect(out.result.sent).toBe(2);
    expect(out.result.failed).toBe(0);

    const a1 = only(out, A, W1);
    expect([...a1.entryIds].sort()).toEqual([e1, e2, e3].sort());
    expect(a1.email.idempotencyKey).toBe(`catchup:${A}:${W1}:${LOCAL_DATE}:10:30`);
    expect(a1.email.to).toBe(w.emails.get(A));
    expect(a1.email.from).toBe(ENV.CATCHUP_FROM_ADDRESS);
    expect(a1.email.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(a1.email.headers['List-Unsubscribe']).toContain(ENV.SUPABASE_URL);
    expect(a1.email.headers['List-Unsubscribe']).toContain(A);

    const a2 = only(out, A, W2);
    expect([...a2.entryIds]).toEqual([e4]);
    expect(a2.email.idempotencyKey).toBe(`catchup:${A}:${W2}:${LOCAL_DATE}:10:30`);
  });

  it('counts a provider failure as failed, not sent', async () => {
    const w = new World();
    w.user(A, 'Anna Client');
    w.workspace(W1, 'Alphaworks Wone');
    w.member(W1, A, 'client');
    const post = w.post(W1, 'Alpha approved post', 'approved');
    w.comment(A, W1, post);

    const out = await run(w, { failDelivery: true });
    expect(out.deliveries).toHaveLength(1);
    expect(out.result.sent).toBe(0);
    expect(out.result.failed).toBe(1);
  });

  it('skips a user with no auth email', async () => {
    const w = new World();
    w.user(A, 'Anna Client', { email: null });
    w.workspace(W1, 'Alphaworks Wone');
    w.member(W1, A, 'client');
    const post = w.post(W1, 'Alpha approved post', 'approved');
    w.comment(A, W1, post);

    const out = await run(w);
    expect(out.deliveries).toHaveLength(0);
  });
});

describe('runCatchup: schedule', () => {
  function scheduleWorld(): World {
    const w = new World();
    w.user(A, 'Anna Client');
    w.user(C, 'Cora Client', { timezone: null });
    w.user(D, 'Dora Client', { timezone: null });
    w.workspace(W1, 'Alphaworks Wone');
    w.workspace(W5, 'Epsilonco Wfive', null);
    w.member(W1, A, 'client');
    w.member(W1, C, 'client');
    w.member(W5, D, 'client');
    const alpha = w.post(W1, 'Alpha approved post', 'approved');
    const eps = w.post(W5, 'Epsilon approved post', 'approved');
    w.comment(A, W1, alpha);
    w.comment(C, W1, alpha);
    w.comment(D, W5, eps);
    return w;
  }

  it('sends nothing outside a slot', async () => {
    const out = await run(scheduleWorld(), { now: NOT_SLOT_NOW });
    expect(out.deliveries).toHaveLength(0);
    expect(out.result.sent).toBe(0);
  });

  it('falls back to the workspace zone and skips when both zones are null', async () => {
    const out = await run(scheduleWorld());
    expect(deliveriesFor(out, A, W1)).toHaveLength(1);
    expect(deliveriesFor(out, C, W1)).toHaveLength(1);
    expect(deliveriesFor(out, D)).toHaveLength(0);
  });
});

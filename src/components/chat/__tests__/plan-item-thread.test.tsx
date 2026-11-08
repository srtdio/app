// @vitest-environment jsdom
// Plan item: conversational comments, @ tagging, header menu. The thread is
// drawn by chat's own parts (MessageBubble: everyone on the left, a group head
// = square photo + name + clock time, chat's 5 min runs and day pills, a
// "Creators only" line on creators-only notes, chat's @mention names, clock
// while pending, "Not sent" + Retry on a failure); Remove from plan lives
// only in the concept's More menu; the
// box tags people through chat's picker (never me; agency side only on a
// creators-only note or a plan not shared with the client), sends @[id]
// tokens, holds Send while a creators-only note tags an approver, and toasts
// the server's invalid_mention refusal with the draft kept. Reads, writes and
// heavy children are stubbed; the members come from the held cache.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { ItemScreenData, PlanBundle, PlanItemRow } from '@/lib/chat/plans';
import type { Result } from '@srtdio/rpc';

const ME = '11111111-1111-4111-8111-111111111111';
const ASHA = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';

const env = vi.hoisted(() => ({
  laptop: true,
  coarse: false,
  result: null as unknown,
  members: null as unknown,
  comment: vi.fn(),
}));

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'ws', workspaces: [] }),
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: '11111111-1111-4111-8111-111111111111' } } }),
}));
vi.mock('@/lib/chat-reads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat-reads')>()),
  readProfiles: async () => ({ ok: true, data: [] }),
}));
vi.mock('@/lib/people-names', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/people-names')>()),
  resolvePeople: async () => undefined,
}));
vi.mock('@/lib/workspace-members', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-members')>()),
  peekWorkspaceMembers: () => env.members,
}));
vi.mock('@/lib/chat/open-members', () => ({
  startChatMembers: vi.fn(async () => ({ error: 'stub', rows: [], profiles: new Map() })),
}));
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => env.laptop,
  useCoarsePointer: () => env.coarse,
}));
vi.mock('@/components/chat/PostPicker', () => ({ PostPicker: () => null }));
vi.mock('@/components/chat/AssetPicker', () => ({ AssetPicker: () => null }));
vi.mock('@/components/chat/PlanCardsProvider', () => ({ usePlanCards: () => null }));
vi.mock('@/components/media/Thumbnail', () => ({ Thumbnail: () => null }));
vi.mock('@/components/ui/LinkPreviewCard', () => ({ LinkPreviewCard: () => null }));
vi.mock('@/lib/chat/use-chat-attachments', () => ({
  useCommentAttachments: () => ({ canAttach: false, uploadFile: undefined }),
}));
vi.mock('@/components/pages/PostDetailPage', () => ({
  PostDetailPage: () => <div data-test-post-detail="" />,
}));
vi.mock('@srtdio/rpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@srtdio/rpc')>()),
  planItemCommentCreate: env.comment,
}));
vi.mock('@/lib/chat/plans', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chat/plans')>()),
  readItemScreen: async () => env.result,
}));

import {
  COMMENT_PLACEHOLDER,
  PlanItemScreen,
  planItemMenuItems,
} from '@/components/chat/PlanItemScreen';
import {
  MENTION_TEAM_NOTE,
  PLAN_RUN_GAP_MS,
  PlanItemThread,
  blockedMentions,
  breaksPlanRun,
  isInvalidMention,
  mentionKeyAction,
  mentionsRestricted,
  planCommentMenu,
  planCommentMessage,
  planCommentProfiles,
  planPickerRows,
  planThreadRows,
  type ShownComment,
} from '@/components/chat/PlanItemThread';
import { ToastProvider, ToastViewport } from '@/components/ui/toast';
import { resetHistorySteps } from '@/lib/chat/use-history-step';
import { rememberMentionNames, resetMentionNames, type MentionMember } from '@/lib/chat/mentions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Repo-relative reads (the jsdom environment's import.meta.url is not a file URL).
const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8');

// ---------------------------------------------------------------------------
// Pure: runs and day lines
// ---------------------------------------------------------------------------

function shown(over: Partial<ShownComment>): ShownComment {
  return {
    id: 'c',
    authorUserId: ASHA,
    authorName: 'Asha',
    mine: false,
    body: 'Hello',
    visibility: 'everyone',
    createdAt: '2026-11-02T09:00:00Z',
    pending: false,
    ...over,
  };
}

const NOW = Date.parse('2026-11-02T12:00:00Z');

describe('grouping and day lines', () => {
  it('one author within 5 min is one run; a gap, another author or own vs other breaks it', () => {
    const a = shown({ id: 'a', createdAt: '2026-11-02T09:00:00Z' });
    const b = shown({ id: 'b', createdAt: '2026-11-02T09:04:00Z' });
    const c = shown({ id: 'c', createdAt: '2026-11-02T09:09:00Z' });
    expect(PLAN_RUN_GAP_MS).toBe(300000);
    expect(breaksPlanRun(undefined, a)).toBe(true);
    expect(breaksPlanRun(a, b)).toBe(false);
    expect(breaksPlanRun(b, c)).toBe(true);
    expect(breaksPlanRun(a, shown({ authorUserId: CLIENT }))).toBe(true);
    expect(breaksPlanRun(a, shown({ mine: true, authorUserId: ME }))).toBe(true);
  });

  it('head and tail mark each run; the time sits under the tail only', () => {
    const rows = planThreadRows(
      [
        shown({ id: 'a', createdAt: '2026-11-02T09:00:00Z' }),
        shown({ id: 'b', createdAt: '2026-11-02T09:03:00Z' }),
        shown({ id: 'c', mine: true, authorUserId: ME, createdAt: '2026-11-02T09:04:00Z' }),
      ],
      NOW,
      'UTC',
    );
    const comments = rows.flatMap((r) => (r.kind === 'comment' ? [r] : []));
    expect(comments.map((r) => [r.comment.id, r.head, r.tail])).toEqual([
      ['a', true, false],
      ['b', false, true],
      ['c', true, true],
    ]);
  });

  it('a day line before the first comment and each new day: Today, Yesterday, then weekday + day', () => {
    const rows = planThreadRows(
      [
        shown({ id: 'a', createdAt: '2026-10-28T09:00:00Z' }),
        shown({ id: 'b', createdAt: '2026-11-01T09:00:00Z' }),
        shown({ id: 'c', createdAt: '2026-11-01T09:01:00Z' }),
        shown({ id: 'd', createdAt: '2026-11-02T09:00:00Z' }),
      ],
      NOW,
      'UTC',
    );
    expect(
      rows.filter((r) => r.kind === 'day').map((r) => (r.kind === 'day' ? r.label : '')),
    ).toEqual(['Wed 28 Oct', 'Yesterday', 'Today']);
    // A day line ends a run: b heads its own run after the line.
    const b = rows.find((r) => r.kind === 'comment' && r.comment.id === 'b');
    expect(b?.kind === 'comment' && b.head).toBe(true);
    const a = rows.find((r) => r.kind === 'comment' && r.comment.id === 'a');
    expect(a?.kind === 'comment' && a.tail).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rendered thread: alignment, team style, pills
// ---------------------------------------------------------------------------

describe('the thread is drawn by chat', () => {
  beforeEach(() => {
    resetMentionNames();
    env.members = null;
  });

  const host = (html: string): HTMLElement => {
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
  };

  it("chat's rows: everyone on the left, a head carries the name + time line, the ids stay on the row", () => {
    const el = host(
      renderToStaticMarkup(
        <PlanItemThread
          comments={[
            shown({ id: 'o', body: 'From Asha', authorKnown: true }),
            shown({ id: 'm', mine: true, authorUserId: ME, authorName: 'You', body: 'Mine' }),
          ]}
          workspaceId="ws"
          me={ME}
        />,
      ),
    );
    const other = el.querySelector('[data-plan-comment-id="o"]') as HTMLElement;
    const own = el.querySelector('[data-plan-comment-id="m"]') as HTMLElement;
    // Chat's own row (MessageBubble) with the plan hooks on it.
    expect(other.hasAttribute('data-msg-id')).toBe(true);
    expect(other.getAttribute('data-plan-comment-side')).toBe('other');
    expect(own.getAttribute('data-plan-comment-side')).toBe('own');
    expect(other.querySelector('[data-sender-name]')?.textContent).toBe('Asha');
    expect(other.querySelector('[data-sender-time]')).not.toBeNull();
    // L1: no right-aligned own bubble, no bubble-own fill.
    expect(own.className).not.toContain('justify-end');
    expect(own.innerHTML).not.toContain('bg-bubble-own');
    expect(own.querySelector('[data-sender-name]')).not.toBeNull();
    expect(el.innerHTML).not.toContain('text-white');
  });

  it("chat's grouping: one author within 5 min shares one head; a day pill sits above", () => {
    const el = host(
      renderToStaticMarkup(
        <PlanItemThread
          comments={[
            shown({ id: 'a', createdAt: '2026-11-02T09:00:00Z' }),
            shown({ id: 'b', createdAt: '2026-11-02T09:03:00Z' }),
          ]}
          workspaceId="ws"
          me={ME}
        />,
      ),
    );
    expect(el.querySelectorAll('[data-sender-line]')).toHaveLength(1);
    const a = el.querySelector('[data-plan-comment-id="a"]');
    const b = el.querySelector('[data-plan-comment-id="b"]');
    expect(a?.hasAttribute('data-plan-run-head')).toBe(true);
    expect(b?.hasAttribute('data-plan-run-head')).toBe(false);
    expect(el.querySelector('li[role="separator"]')).not.toBeNull();
  });

  it('a creators-only note carries the lock and "Creators only" inside its bubble', () => {
    const html = renderToStaticMarkup(
      <PlanItemThread
        comments={[shown({ id: 't', visibility: 'team', mine: true, authorUserId: ME })]}
        workspaceId="ws"
        me={ME}
      />,
    );
    expect(html).toMatch(/data-plan-comment-team=""[^>]*>[\s\S]*?<svg[\s\S]*?Creators only/);
    expect(html).toContain('data-plan-comment="team"');
    expect(html).not.toContain('bg-bubble-own');
  });

  it("tags render as chat's mention names, never a raw token", () => {
    rememberMentionNames('ws', [{ userId: CLIENT, displayName: 'Cli', username: 'cli' }]);
    const body = `hi @[${CLIENT}]`;
    const html = renderToStaticMarkup(
      <PlanItemThread
        comments={[
          shown({ id: 'o', body }),
          shown({ id: 'm', body, mine: true, authorUserId: ME }),
        ]}
        workspaceId="ws"
        me={ME}
      />,
    );
    expect(html).toContain(`data-mention="${CLIENT}"`);
    expect(html).toContain('@cli');
    expect(html).not.toContain(`@[${CLIENT}]`);
  });

  it('a pending comment shows the clock; a failed one "Not sent" with Retry and Delete', () => {
    const html = renderToStaticMarkup(
      <PlanItemThread
        comments={[
          shown({ id: 'p', mine: true, authorUserId: ME, pending: true }),
          shown({ id: 'f', mine: true, authorUserId: ME, failed: true, body: 'Oops' }),
        ]}
        workspaceId="ws"
        me={ME}
        onRetry={() => undefined}
        onDiscard={() => undefined}
      />,
    );
    const el = host(html);
    const pendingRow = el.querySelector('[data-plan-comment-id="p"]');
    expect(pendingRow?.getAttribute('data-state')).toBe('sending');
    const failed = el.querySelector('[data-plan-comment-id="f"]') as HTMLElement;
    expect(failed.getAttribute('data-state')).toBe('failed');
    expect(failed.textContent).toContain('Not sent');
    expect(failed.querySelector('[data-failed-line-retry]')).not.toBeNull();
    expect(failed.querySelector('[data-failed-delete]')).not.toBeNull();
  });
});

describe('planCommentMessage and planCommentMenu', () => {
  it('maps a comment onto a chat message: sent, sending or failed; no files, quotes or reactions', () => {
    expect(planCommentMessage(shown({})).state).toBe('sent');
    expect(planCommentMessage(shown({ pending: true })).state).toBe('sending');
    const failed = planCommentMessage(shown({ failed: true, refusal: 'No' }));
    expect(failed.state).toBe('failed');
    expect(failed.refusal).toBe('No');
    const m = planCommentMessage(shown({}));
    expect(m.attachments).toEqual([]);
    expect(m.reply).toBeNull();
    expect(m.reactions).toEqual([]);
    expect(m.senderUserId).toBe(ASHA);
  });

  it('the menu offers Reply, Copy link and Reply privately on recorded comments only; Delete on a failed own one', () => {
    const base = { canReply: true, canLink: true, replyPrivately: true };
    expect(planCommentMenu({ ...base, comment: shown({}) })).toEqual({
      reply: true,
      copy: true,
      copyLink: true,
      replyPrivately: true,
      discard: false,
    });
    expect(planCommentMenu({ ...base, comment: shown({ pending: true }) })).toEqual({
      reply: false,
      copy: true,
      copyLink: false,
      replyPrivately: false,
      discard: false,
    });
    const failedOwn = planCommentMenu({ ...base, comment: shown({ mine: true, failed: true }) });
    expect(failedOwn.discard).toBe(true);
    expect(planCommentMenu({ ...base, canReply: false, comment: shown({}) }).reply).toBe(false);
  });

  it('profiles: held members first, then authors whose name the read answered', () => {
    const held = {
      profiles: new Map([[ME, { userId: ME, displayName: 'Me', avatarUrl: null }]]),
    };
    const out = planCommentProfiles(
      [
        shown({ authorKnown: true }),
        shown({ id: 'x', authorUserId: CLIENT, authorName: 'Member' }),
      ],
      held,
      'ws',
    );
    expect(out.get(ME)?.displayName).toBe('Me');
    expect(out.get(ASHA)?.displayName).toBe('Asha');
    expect(out.has(CLIENT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pure: who can be tagged
// ---------------------------------------------------------------------------

const MEMBERS: MentionMember[] = [
  { userId: ME, displayName: 'Me', username: 'me', avatarUrl: null, role: 'owner' },
  { userId: ASHA, displayName: 'Asha', username: 'asha', avatarUrl: null, role: 'agency' },
  { userId: CLIENT, displayName: 'Cli', username: 'cli', avatarUrl: null, role: 'client' },
];

describe('picker filtering', () => {
  it('never offers me; everyone on an open note', () => {
    const { rows, hiddenApprovers } = planPickerRows(MEMBERS, '', ME, false);
    expect(rows.map((m) => m.userId)).toEqual([ASHA, CLIENT]);
    expect(hiddenApprovers).toBe(false);
  });

  it('creators-only or a plan not shared with the client: agency side only, approvers flagged', () => {
    expect(mentionsRestricted('team', 'client')).toBe(true);
    expect(mentionsRestricted('everyone', 'team')).toBe(true);
    expect(mentionsRestricted('everyone', 'client')).toBe(false);
    const { rows, hiddenApprovers } = planPickerRows(MEMBERS, '', ME, true);
    expect(rows.map((m) => m.userId)).toEqual([ASHA]);
    expect(hiddenApprovers).toBe(true);
    // A query no approver matches shows no note.
    expect(planPickerRows(MEMBERS, 'ash', ME, true).hiddenApprovers).toBe(false);
  });

  it('a restricted note blocks only its approver tags; an open note blocks none', () => {
    const body = `@[${ASHA}] and @[${CLIENT}]`;
    expect(blockedMentions(body, MEMBERS, true)).toEqual([CLIENT]);
    expect(blockedMentions(body, MEMBERS, false)).toEqual([]);
    expect(blockedMentions(body, null, true)).toEqual([]);
  });

  it('the open picker takes Up, Down, Enter, Tab and Escape; never during composition', () => {
    expect(mentionKeyAction('ArrowUp', false)).toBe('up');
    expect(mentionKeyAction('ArrowDown', false)).toBe('down');
    expect(mentionKeyAction('Enter', false)).toBe('pick');
    expect(mentionKeyAction('Tab', false)).toBe('pick');
    expect(mentionKeyAction('Escape', false)).toBe('close');
    expect(mentionKeyAction('a', false)).toBeNull();
    expect(mentionKeyAction('Enter', true)).toBeNull();
  });

  it('the refusal code maps to the toast', () => {
    expect(isInvalidMention('invalid_mention')).toBe(true);
    expect(isInvalidMention('forbidden_role')).toBe(false);
    expect(MENTION_TEAM_NOTE).toBe(
      "Approvers can't see creators-only notes, so they can't be tagged here.",
    );
    expect(MENTION_TEAM_NOTE).not.toContain(String.fromCharCode(0x2014));
  });
});

// ---------------------------------------------------------------------------
// Source rules: menu, imports, migration
// ---------------------------------------------------------------------------

describe('Remove from plan: only in the More menu', () => {
  it('Move, Edit concept, then Remove from plan, red and last', () => {
    const noop = (): void => undefined;
    const items = planItemMenuItems({ onMove: noop, onEdit: noop, onRemove: noop });
    expect(items.map((i) => i.label)).toEqual([
      'Move to another day',
      'Edit concept',
      'Remove from plan',
    ]);
    expect(items[2]?.tone).toBe('danger');
    expect(items.slice(0, 2).every((i) => i.tone === undefined)).toBe(true);
  });

  it('the concept body has no red button; the screen never imports the chat thread or composer', () => {
    // The thread file draws with chat's MessageBubble; the screen itself stays clear of it.
    expect(read('src/components/chat/PlanItemThread.tsx')).toContain('<MessageBubble');
    const src = read('src/components/chat/PlanItemScreen.tsx');
    const concept = src.slice(
      src.indexOf('data-plan-description-card'),
      src.indexOf('</PlanPage>'),
    );
    expect(concept).not.toContain('RemoveFromPlanButton');
    expect(concept).not.toContain('data-plan-remove-row');
    expect(src).not.toMatch(/from '@\/components\/chat\/MessageThread'/);
    expect(src).not.toMatch(/from '@\/components\/chat\/Composer'/);
    expect(src).not.toContain('MentionInput');
  });
});

describe('the migration record', () => {
  it('is the approved SQL: three functions, the revoke, no DROP and no trigger', () => {
    const sql = read('supabase/migrations/20261102090000_plan_comment_mentions.sql');
    expect(sql.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(3);
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public._plan_item_notify_except(p_item_id uuid, p_event_type text, p_team_only boolean, p_payload jsonb, p_exclude uuid[])',
    );
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public._plan_item_notify_except(uuid, text, boolean, jsonb, uuid[]) FROM PUBLIC, anon, authenticated;',
    );
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION public.plan_item_comment_create(p_item_id uuid, p_body text, p_visibility text, p_trace_id uuid)',
    );
    expect(sql).toContain("raise exception 'invalid_mention'");
    expect(sql).toContain(
      "perform public._plan_item_notify_except(p_item_id, p_event_type, p_team_only, p_payload, '{}'::uuid[]);",
    );
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bTRIGGER\b/i);
  });
});

// ---------------------------------------------------------------------------
// Mounted screen: the box, the chip, the picker, the menu
// ---------------------------------------------------------------------------

const CONCEPT: PlanItemRow = {
  id: 'c1',
  plan_id: 'plan',
  kind: 'concept',
  position: 0,
  title: 'Plant tour reel',
  description: '',
  post_id: null,
  created_at: '2026-10-09T10:00:00Z',
  target_date: '2026-10-13',
};

const BUNDLE: PlanBundle = {
  plan: {
    id: 'plan',
    workspace_id: 'ws',
    title: 'Week of 12 Oct',
    starts_on: '2026-10-12',
    ends_on: '2026-10-18',
    audience: 'client',
    created_by: ME,
  },
  items: [CONCEPT],
  reviews: [],
  postStages: {},
  postInfo: {},
};

const HELD = {
  loading: false,
  error: null,
  rows: [
    { user_id: ME, active: true, removed_at: null, role: 'owner' },
    { user_id: ASHA, active: true, removed_at: null, role: 'agency' },
    { user_id: CLIENT, active: true, removed_at: null, role: 'client' },
  ],
  profiles: new Map([
    [ME, { userId: ME, displayName: 'Me', avatarUrl: null, username: 'me' }],
    [ASHA, { userId: ASHA, displayName: 'Asha', avatarUrl: null, username: 'asha' }],
    [CLIENT, { userId: CLIENT, displayName: 'Cli', avatarUrl: null, username: 'cli' }],
  ]),
  options: [],
};

function ready(data: Partial<ItemScreenData>): Result<ItemScreenData> {
  return { ok: true, data: { comments: [], files: [], names: {}, ...data } };
}

let root: Root | null = null;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => act(async () => wait(60));

async function mount(side: 'agency' | 'client', bundle: PlanBundle = BUNDLE): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <MemoryRouter>
        <ToastProvider>
          <PlanItemScreen open bundle={bundle} item={CONCEPT} side={side} onClose={() => {}} />
          <ToastViewport />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
  await settle();
  await settle();
}

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
  document.querySelector<T>(sel);

function type(el: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function key(el: HTMLElement, init: KeyboardEventInit): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

const box = (): HTMLTextAreaElement =>
  $<HTMLTextAreaElement>('[data-plan-comment-input]') as HTMLTextAreaElement;
const options = (): string[] =>
  [...document.querySelectorAll('[data-mention-option]')].map(
    (el) => el.getAttribute('data-mention-option') ?? '',
  );

beforeEach(() => {
  resetHistorySteps();
  resetMentionNames();
  env.laptop = true;
  env.coarse = false;
  env.members = HELD;
  env.result = ready({});
  env.comment.mockReset();
  env.comment.mockImplementation(async () => ({ ok: true, data: 'cm-new' }));
});

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  await settle();
  resetHistorySteps();
});

describe('one chat per item', () => {
  it('agency: no who-can-see chip; every comment goes to everyone', async () => {
    await mount('agency');
    expect($('[data-plan-visibility-chip]')).toBeNull();
    expect($('[data-plan-visibility-line]')).toBeNull();
    expect(box().placeholder).toBe(COMMENT_PLACEHOLDER);
    box().focus();
    await act(async () => type(box(), 'For all'));
    await act(async () => key(box(), { key: 'Enter' }));
    await settle();
    const args = env.comment.mock.calls[0]?.[1] as { p_visibility: string };
    expect(args.p_visibility).toBe('everyone');
  });

  it('client: the same box, no chip and no line, and no More button', async () => {
    await mount('client');
    expect($('[data-plan-visibility-chip]')).toBeNull();
    expect($('[data-plan-visibility-line]')).toBeNull();
    expect(box().placeholder).toBe(COMMENT_PLACEHOLDER);
    expect($('[data-plan-item-more]')).toBeNull();
  });
});

describe('Remove from plan in the header More menu', () => {
  it('agency: no red button in the body; the More menu ends with Remove from plan', async () => {
    await mount('agency');
    expect($('[data-plan-remove]')).toBeNull();
    const more = $('[data-plan-item-more]') as HTMLButtonElement;
    await act(async () => more.click());
    await settle();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Move to another day');
    expect(text).toContain('Edit concept');
    expect(text.lastIndexOf('Remove from plan')).toBeGreaterThan(text.lastIndexOf('Edit concept'));
  });
});

describe('@ tagging', () => {
  it('members load on focus, never on paint; the picker never offers me', async () => {
    await mount('agency');
    expect($('[data-mention-picker]')).toBeNull();
    box().focus();
    await act(async () => type(box(), '@'));
    await settle();
    expect(options()).toEqual([ASHA, CLIENT]);
    expect(options()).not.toContain(ME);
  });

  it('a plan not shared with the client: agency side only, even for Everyone', async () => {
    await mount('agency', { ...BUNDLE, plan: { ...BUNDLE.plan, audience: 'team' } });
    box().focus();
    await act(async () => type(box(), '@'));
    await settle();
    expect(options()).toEqual([ASHA]);
  });

  it('Enter picks while the picker is open; the next Enter sends @[id] in the body', async () => {
    await mount('agency');
    box().focus();
    await act(async () => type(box(), '@as'));
    await settle();
    await act(async () => key(box(), { key: 'Enter' }));
    await settle();
    expect(env.comment).not.toHaveBeenCalled();
    expect(box().value).toBe('@asha ');
    await act(async () => type(box(), '@asha looks good'));
    await act(async () => key(box(), { key: 'Enter' }));
    await settle();
    expect(env.comment).toHaveBeenCalledTimes(1);
    const args = env.comment.mock.calls[0]?.[1] as { p_body: string; p_visibility: string };
    expect(args.p_body).toBe(`@[${ASHA}] looks good`);
    expect(args.p_visibility).toBe('everyone');
  });

  it('a server invalid_mention refusal toasts the note and keeps the draft', async () => {
    env.comment.mockImplementation(async () => ({
      ok: false,
      error: { message: 'invalid_mention' },
    }));
    await mount('agency');
    box().focus();
    await act(async () => type(box(), 'Keep me'));
    await act(async () => key(box(), { key: 'Enter' }));
    await settle();
    expect(env.comment).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(MENTION_TEAM_NOTE);
    expect(box().value).toBe('Keep me');
    expect(document.querySelector('[role="alert"]')?.textContent ?? '').not.toContain("Couldn't");
  });

  it('after a send the new comment is in the thread as your own', async () => {
    await mount('agency');
    box().focus();
    await act(async () => type(box(), 'Hi team'));
    await act(async () => key(box(), { key: 'Enter' }));
    await settle();
    const row = $('[data-plan-comment-id="cm-new"]');
    expect(row?.getAttribute('data-plan-comment-side')).toBe('own');
  });

  it('a failed write keeps the row as "Not sent"; Retry sends the same body again', async () => {
    env.comment.mockImplementationOnce(async () => ({ ok: false, error: { message: 'boom' } }));
    await mount('agency');
    box().focus();
    await act(async () => type(box(), 'Try me'));
    await act(async () => key(box(), { key: 'Enter' }));
    await settle();
    // Chat's send: the box cleared in the same tap; the row stays, failed.
    expect(box().value).toBe('');
    const failed = $('[data-plan-comment-side="own"][data-state="failed"]');
    expect(failed?.textContent).toContain('Not sent');
    expect(document.querySelector('[role="alert"]')?.textContent ?? '').not.toContain("Couldn't");
    const retry = failed?.querySelector<HTMLButtonElement>('[data-failed-line-retry]');
    await act(async () => retry?.click());
    await settle();
    expect(env.comment).toHaveBeenCalledTimes(2);
    expect((env.comment.mock.calls[1]?.[1] as { p_body: string }).p_body).toBe('Try me');
    expect($('[data-plan-comment-id="cm-new"]')?.getAttribute('data-state')).toBe('sent');
  });
});

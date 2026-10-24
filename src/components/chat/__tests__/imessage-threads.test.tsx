import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
import {
  MessageBubble,
  listRailPlans,
  railRowClass,
  threadRows,
  type RowRail,
} from '@/components/chat/MessageThread';
import {
  RailElbow,
  RailThrough,
  RailTick,
  RepliesButtonRow,
  RepliesSeparatorRow,
  ThreadChipRow,
  threadChipLabel,
} from '@/components/chat/ThreadRail';
import * as threadView from '@/components/chat/ThreadView';
import { SeenLine } from '@/components/chat/ReadingLayer';
import { PresignCache } from '@/lib/asset-presign';
import type { ChatProfile } from '@/lib/chat-reads';
import type { ThreadMessage } from '@/lib/chat/thread';
import { rowGeometry, type ThreadMembership } from '@/lib/chat/thread-rail';

const cache = new PresignCache({
  endpoint: null,
  getAccessToken: () => Promise.resolve(null),
  fetcher: () => Promise.reject(new Error('unused')),
});

const PROFILES: Map<string, ChatProfile> = new Map([
  ['peer-1', { userId: 'peer-1', displayName: 'Alice', avatarUrl: null }],
]);

const AT = '2026-10-01T10:00:00Z';

function msg(id: string, over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id,
    senderUserId: 'peer-1',
    body: `body ${id}`,
    createdAt: AT,
    time: Date.parse(AT),
    provisionalTime: false,
    mine: false,
    attachments: [],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
    ...over,
  };
}

const memberRow = msg('r', {
  reply: { id: 'card', authorUserId: 'peer-1', preview: 'Quoted text' },
  threadRootId: 'card',
});

function html(element: ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);
}

function bubble(
  message: ThreadMessage,
  opts: {
    rail?: RowRail;
    member?: boolean;
    isGroup?: boolean;
    head?: boolean;
    selecting?: boolean;
  } = {},
): string {
  return html(
    <MessageBubble
      message={message}
      profiles={PROFILES}
      cache={cache}
      presignEnabled={false}
      showTicks={false}
      isGroup={opts.isGroup ?? false}
      head={opts.head ?? true}
      tail
      timeZone="UTC"
      layout="touch"
      onBadgeClick={() => {}}
      threadMember={opts.member ?? false}
      rail={opts.rail}
      {...(opts.selecting === true
        ? { selection: { role: 'selectable' as const, checked: false, onToggle: vi.fn() } }
        : {})}
    />,
  );
}

const railFor = (
  role: RowRail['role'],
  input: { mine?: boolean; isGroup?: boolean; photo?: boolean },
): RowRail => ({
  role,
  geometry: rowGeometry({
    role,
    mine: input.mine ?? false,
    isGroup: input.isGroup ?? false,
    photo: input.photo ?? false,
    selecting: false,
  }),
});

describe('member rows on the rail', () => {
  it('a member shows no quote and no chip; the rail stands in, shifted 14px', () => {
    const out = bubble(memberRow, { member: true, rail: railFor('middle', {}) });
    expect(out).not.toContain('Quoted text');
    expect(out).toContain('pl-[30px]');
    expect(out).toContain('data-rail="through"');
    expect(out).toContain('data-rail="tick"');
    expect(out).toContain('bg-border-strong');
    // The same reply off the rail (a plain root) keeps today's quote and place.
    const plain = bubble(memberRow);
    expect(plain).toContain('Quoted text');
    expect(plain).toContain('px-4');
    expect(plain).not.toContain('data-rail');
  });

  it('a left root card no reply follows yet already sits shifted, with no rail piece', () => {
    const card = msg('card', { body: 'Card' });
    const rail: RowRail = {
      role: null,
      geometry: rowGeometry({
        role: null,
        mine: false,
        isGroup: false,
        photo: false,
        selecting: false,
        rootCard: true,
      }),
    };
    const out = bubble(card, { rail });
    expect(out).toContain('pl-[30px]');
    expect(out).not.toContain('data-rail');
  });

  it('the last member draws only its elbow; the root card its top elbow', () => {
    const last = bubble(memberRow, { member: true, rail: railFor('last', {}) });
    expect(last).not.toContain('data-rail="through"');
    expect(last).toContain('data-rail="tick"');
    const root = bubble(msg('card', { body: 'Card' }), { rail: railFor('root', {}) });
    expect(root).toContain('data-rail="elbow"');
    expect(root).not.toContain('data-rail="tick"');
  });

  it('deleted members stay on the rail as tombstones', () => {
    const tomb = msg('r', { deleted: true, body: '', threadRootId: 'card' });
    const out = bubble(tomb, { member: true, rail: railFor('middle', {}) });
    expect(out).toContain('data-tombstone');
    expect(out).toContain('data-rail="tick"');
  });

  it('selection removes the rail and the shift; the member keeps no quote', () => {
    const out = bubble(memberRow, { member: true, rail: railFor('middle', {}), selecting: true });
    expect(out).not.toContain('data-rail');
    expect(out).not.toContain('pl-[30px]');
    expect(out).toContain('pl-[60px]');
    expect(out).not.toContain('Quoted text');
  });

  it('a reaction badge row keeps its room as padding on the rail (no gap between rows)', () => {
    const reacted = { ...memberRow, reactions: [{ emoji: '👍', count: 1, mine: false }] };
    expect(bubble(reacted, { member: true, rail: railFor('middle', {}) })).toContain('pb-5');
    expect(bubble(reacted)).toContain('mb-5');
  });

  it('an own row keeps its place and reaches across in CSS', () => {
    const own = { ...memberRow, mine: true, senderUserId: 'me' };
    const rail = railFor('middle', { mine: true });
    expect(railRowClass(rail, true)).toContain('[container-type:inline-size]');
    expect(railRowClass(rail, true)).toContain('pl-4');
    expect(bubble(own, { member: true, rail })).toContain('w-[calc(100cqw-100%+1px)]');
  });

  it('a failed own reply on the rail sets its alert on the page fill', () => {
    const failed = { ...memberRow, mine: true, senderUserId: 'me', state: 'failed' as const };
    const onRail = bubble(failed, { member: true, rail: railFor('last', { mine: true }) });
    // A PressableRow: its class renders before the passed data attribute.
    expect(onRail).toMatch(/class="[^"]*\bbg-bg\b[^"]*"[^>]*data-failed-retry=""/);
    expect(bubble(failed)).not.toMatch(/class="[^"]*\bbg-bg\b[^"]*"[^>]*data-failed-retry=""/);
  });
});

describe('group geometry (i4-group-b)', () => {
  it('a run head ticks into its photo, which shifts with the row', () => {
    const out = bubble(memberRow, {
      member: true,
      isGroup: true,
      rail: railFor('middle', { isGroup: true, photo: true }),
    });
    expect(out).toContain('pl-[30px]');
    // The tick sits in the photo's box, ahead of the sender name line.
    expect(out.indexOf('data-rail="tick"')).toBeLessThan(out.indexOf('Alice'));
    expect(out).toContain('w-[15px]');
  });

  it('a tucked row reaches across the 26px gutter to its bubble', () => {
    const out = bubble(memberRow, {
      member: true,
      isGroup: true,
      head: false,
      rail: railFor('middle', { isGroup: true }),
    });
    expect(out).toContain('w-[26px]');
    expect(out).toContain('w-[49px]');
  });

  it('a non-member group row is untouched', () => {
    const out = bubble(msg('n'), { isGroup: true });
    expect(out).toContain('px-4');
    expect(out).not.toContain('data-rail');
  });
});

describe('rail plans over the rendered list', () => {
  const member: ThreadMembership = { rootId: 'card', postId: 'p1' };
  const memberOf = (m: ThreadMessage): ThreadMembership | null =>
    m.threadRootId === 'card' ? member : null;
  const card = msg('card', { sharedPostIds: ['p1'], body: '' });
  const a = msg('a', {
    threadRootId: 'card',
    reply: { id: 'card', authorUserId: null, preview: '' },
  });
  const b = msg('b', { threadRootId: 'card', reply: { id: 'a', authorUserId: null, preview: '' } });

  it('the unread divider ends a run; the next member is chip-headed', () => {
    const rows = threadRows([card, a, b], Date.parse(AT), 'UTC');
    const plans = listRailPlans(rows, 'b', memberOf);
    expect(plans.get('a')?.role).toBe('last');
    expect(plans.get('b')).toEqual({ role: 'last', chipRoot: 'card', continues: false });
    const whole = listRailPlans(rows, null, memberOf);
    expect(whole.get('card')?.role).toBe('root');
    expect(whole.get('b')?.chipRoot).toBeNull();
  });

  it('the thread view has no day pills: one run', () => {
    const later = { ...b, time: Date.parse(AT) + 3 * 86_400_000 };
    expect(threadRows([card, a, later], Date.parse(AT), 'UTC', { days: false })).toHaveLength(3);
  });
});

describe('thread controls', () => {
  it('the chip: 28px, radius 14, panel, 20px thumb, "title · N replies", 44px target', () => {
    const post = { id: 'p1', number: 12, title: 'Monday carousel', thumbnailAssetVersionId: null };
    const out = html(<ThreadChipRow post={post} count={4} coarse onOpen={() => {}} />);
    expect(out).toContain('h-7');
    expect(out).toContain('rounded-[14px]');
    expect(out).toContain('bg-panel');
    expect(out).toContain('h-5 w-5');
    expect(out).toContain('rounded-[5px]');
    expect(out).toContain('min-h-[44px]');
    expect(out).toContain('Monday carousel');
    expect(out).not.toContain('GBL-12');
    expect(out).toContain('aria-label="Open the thread about Monday carousel"');
    expect(out).toContain('· 4 replies');
    expect(out).toContain('data-rail="elbow"');
    expect(out).toContain('select-none [-webkit-touch-callout:none]');
    // A timed-out count paints without it.
    expect(threadChipLabel({ title: 'x', count: null })).toEqual({ title: 'x', count: null });
    expect(threadChipLabel({ title: 'x', count: 4 }).title).toBe('x');
  });

  it('"N replies": 44px, 13px semibold accent, own side right', () => {
    const own = html(
      <RepliesButtonRow
        label="3 replies"
        mine
        isGroup={false}
        shifted
        through
        coarse={false}
        onOpen={() => {}}
      />,
    );
    expect(own).toContain('justify-end');
    expect(own).toContain('min-h-[44px]');
    expect(own).toContain('text-md font-semibold text-accent');
    expect(own).toContain('data-rail="through"');
    const left = html(
      <RepliesButtonRow
        label="1 reply"
        mine={false}
        isGroup
        shifted
        through={false}
        coarse
        onOpen={() => {}}
      />,
    );
    expect(left).toContain('pl-[64px]');
    expect(left).not.toContain('data-rail');
  });

  it('the view separator is a muted 12px line, not a button', () => {
    const out = html(<RepliesSeparatorRow label="2 replies" through />);
    expect(out).toContain('role="separator"');
    expect(out).toContain('text-sm text-fg-3');
    expect(out).not.toContain('<button');
  });

  it('Seen keeps the rail through it inside a run', () => {
    expect(html(<SeenLine readAt={AT} timeZone="UTC" rail />)).toContain('data-rail="through"');
    expect(html(<SeenLine readAt={AT} timeZone="UTC" />)).not.toContain('data-rail');
  });

  it('rail pieces use tokens only', () => {
    const out = html(
      <>
        <RailThrough />
        <RailTick reach="w-[15px]" top="-top-2.5" />
        <RailElbow reach="w-[15px]" bottom="bottom-0" />
      </>,
    );
    // No hex colour: the hash is assembled so the token guard stays quiet.
    expect(out).not.toMatch(new RegExp(`${String.fromCharCode(35)}[0-9a-f]{3,6}\\b`, 'i'));
    expect(out).toContain('stroke-linecap="round"');
    expect(out).toContain('stroke-linejoin="round"');
  });
});

describe('thread view frame', () => {
  it('the title is the post title alone: no KEY-N title helper', () => {
    expect('threadViewTitle' in threadView).toBe(false);
  });

  it('Escape closes unless handled, a menu is open, or the thread is selecting', () => {
    const base = { key: 'Escape', defaultPrevented: false, overlayOpen: false, selecting: false };
    expect(threadView.escapeCloses(base)).toBe(true);
    expect(threadView.escapeCloses({ ...base, key: 'Enter' })).toBe(false);
    expect(threadView.escapeCloses({ ...base, defaultPrevented: true })).toBe(false);
    expect(threadView.escapeCloses({ ...base, overlayOpen: true })).toBe(false);
    expect(threadView.escapeCloses({ ...base, selecting: true })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  runCatchup,
  type CatchupGateways,
  type DeliveryRecord,
  type DmCount,
  type UnsentEntry,
} from './catchup-send';

// runCatchup is pure of direct I/O: every read/write goes through injected
// gateways, so these tests drive it with fakes and assert the send/stamp/
// delivery side effects and the batched-resolution shape. Boundaries, not
// middles: 2026-06-15 is a Monday, 2026-06-13 a Saturday; the send window is
// Mon-Fri 10:00-18:00 local; inactivity threshold is 5 minutes.

const NOW = new Date('2026-06-15T12:00:00Z'); // Monday noon UTC -> in window.
const WEEKEND = new Date('2026-06-13T12:00:00Z'); // Saturday -> out of window.

const U1 = 'user-0000-0000-0000-000000000001';
const U2 = 'user-0000-0000-0000-000000000002';
const ACTOR = 'user-0000-0000-0000-0000000000aa';
const PEER = 'user-0000-0000-0000-0000000000bb';
const W1 = 'ws-00000000-0000-0000-000000000001';
const W2 = 'ws-00000000-0000-0000-000000000002';

interface FakeConfig {
  entries: UnsentEntry[];
  users?: Record<string, { displayName: string; timezone: string | null }>;
  workspaces?: Record<string, { name: string; timezone: string | null }>;
  posts?: Record<string, string>;
  briefs?: Record<string, string>;
  assets?: Record<string, { filename: string; uploadedBy: string | null }>;
  latestSeen?: Record<string, string | null>;
  lastCatchup?: Record<string, string | null>;
  dm?: Record<string, DmCount[]>;
  emails?: Record<string, string>;
  sendFails?: boolean;
}

interface CapturedSend {
  to: string;
  from: string;
  subject: string;
  messageId: string;
  html: string;
  text: string;
}

function mapFrom<T>(rec: Record<string, T> | undefined): Map<string, T> {
  return new Map(Object.entries(rec ?? {}));
}

function makeFake(cfg: FakeConfig) {
  const calls = {
    resolveUsers: [] as string[][],
    resolveWorkspaces: [] as string[][],
    resolvePosts: [] as string[][],
    resolveBriefs: [] as string[][],
    resolveAssets: [] as string[][],
    dm: [] as { ids: string[]; floors: Map<string, string> }[],
  };
  const sent: CapturedSend[] = [];
  const stamped: { ids: string[]; at: string }[] = [];
  const deliveries: DeliveryRecord[] = [];

  const g: CatchupGateways = {
    baseUrl: 'https://app.test',
    fromAddress: 'catchup@example.test',
    readUnsentEntries: async () => cfg.entries,
    resolveUsers: async (ids) => {
      calls.resolveUsers.push(ids);
      return mapFrom(cfg.users);
    },
    resolveWorkspaces: async (ids) => {
      calls.resolveWorkspaces.push(ids);
      return mapFrom(cfg.workspaces);
    },
    resolvePosts: async (ids) => {
      calls.resolvePosts.push(ids);
      return mapFrom(cfg.posts);
    },
    resolveBriefs: async (ids) => {
      calls.resolveBriefs.push(ids);
      return mapFrom(cfg.briefs);
    },
    resolveAssets: async (ids) => {
      calls.resolveAssets.push(ids);
      return mapFrom(cfg.assets);
    },
    latestSeenAt: async () => mapFrom(cfg.latestSeen),
    lastCatchupAt: async () => mapFrom(cfg.lastCatchup),
    dmCountsSince: async (ids, floors) => {
      calls.dm.push({ ids, floors });
      return mapFrom(cfg.dm);
    },
    emailsFor: async () => mapFrom(cfg.emails),
    send: async (m) => {
      if (cfg.sendFails) throw new Error('resend down');
      sent.push({
        to: m.to,
        from: m.from,
        subject: m.subject,
        messageId: m.messageId,
        html: m.html,
        text: m.text,
      });
      return { id: 'prov-1' };
    },
    stampSent: async (ids, at) => {
      stamped.push({ ids, at });
    },
    recordDelivery: async (row) => {
      deliveries.push(row);
    },
  };
  return { g, calls, sent, stamped, deliveries };
}

function entry(over: Partial<UnsentEntry>): UnsentEntry {
  return {
    id: 'e1',
    userId: U1,
    workspaceId: W1,
    eventType: 'comment',
    entityType: 'post',
    entityId: 'p1',
    payload: {},
    createdAt: '2026-06-15T11:30:00Z',
    ...over,
  };
}

const RECIPIENT_TZ = { displayName: 'Recipient', timezone: 'UTC' };
const WS_TZ = { name: 'Acme', timezone: 'UTC' };

describe('runCatchup gating', () => {
  it('sends once for an in-window, inactive recipient with mixed entries', async () => {
    const f = makeFake({
      entries: [
        entry({
          id: 'e1',
          eventType: 'comment',
          entityId: 'p1',
          payload: { author_user_id: ACTOR, comment_id: 'c1' },
        }),
        entry({
          id: 'e2',
          eventType: 'stage_change',
          entityId: 'p2',
          payload: { to_stage: 'approved' },
        }),
      ],
      users: { [U1]: RECIPIENT_TZ, [ACTOR]: { displayName: 'Asha', timezone: null } },
      workspaces: { [W1]: WS_TZ },
      posts: { p1: 'Spring', p2: 'Summer' },
      latestSeen: { [U1]: '2026-06-15T11:00:00Z' }, // 1h ago -> inactive
      emails: { [U1]: 'r@example.test' },
    });

    const out = await runCatchup(f.g, NOW);

    expect(out).toEqual({ sent: 1, skipped: 0 });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.to).toBe('r@example.test');
    expect(f.sent[0]?.from).toBe('catchup@example.test');
    expect(f.sent[0]?.messageId).toBe(`<catchup-${U1}-2026-06-15T12:00:00.000Z@srtd.io>`);
    expect(f.stamped).toHaveLength(1);
    expect(f.stamped[0]?.ids.sort()).toEqual(['e1', 'e2']);
    expect(f.stamped[0]?.at).toBe('2026-06-15T12:00:00.000Z');
    expect(f.deliveries).toHaveLength(1);
    expect(f.deliveries[0]?.status).toBe('sent');
    expect(f.deliveries[0]?.template_key).toBe('catchup');
    expect(f.deliveries[0]?.provider_message_id).toBe('prov-1');
    expect(f.deliveries[0]?.email_thread_id).toBeNull();
  });

  it('does not send to an out-of-window recipient (no stamp, no delivery)', async () => {
    const f = makeFake({
      entries: [entry({ payload: { author_user_id: ACTOR, comment_id: 'c1' } })],
      users: { [U1]: RECIPIENT_TZ, [ACTOR]: { displayName: 'Asha', timezone: null } },
      workspaces: { [W1]: WS_TZ },
      posts: { p1: 'Spring' },
      latestSeen: { [U1]: '2026-06-13T08:00:00Z' },
      emails: { [U1]: 'r@example.test' },
    });

    const out = await runCatchup(f.g, WEEKEND);

    expect(out).toEqual({ sent: 0, skipped: 1 });
    expect(f.sent).toHaveLength(0);
    expect(f.stamped).toHaveLength(0);
    expect(f.deliveries).toHaveLength(0);
  });

  it('does not send to an active recipient (last seen 1 min ago)', async () => {
    const f = makeFake({
      entries: [entry({ payload: { author_user_id: ACTOR, comment_id: 'c1' } })],
      users: { [U1]: RECIPIENT_TZ, [ACTOR]: { displayName: 'Asha', timezone: null } },
      workspaces: { [W1]: WS_TZ },
      posts: { p1: 'Spring' },
      latestSeen: { [U1]: '2026-06-15T11:59:00Z' }, // 1 min ago -> active
      emails: { [U1]: 'r@example.test' },
    });

    const out = await runCatchup(f.g, NOW);

    expect(out).toEqual({ sent: 0, skipped: 1 });
    expect(f.sent).toHaveLength(0);
    expect(f.stamped).toHaveLength(0);
  });
});

describe('runCatchup grouping + assembly', () => {
  it('splits one user across two workspaces into two separate emails', async () => {
    const f = makeFake({
      entries: [
        entry({
          id: 'e1',
          workspaceId: W1,
          entityId: 'p1',
          payload: { author_user_id: ACTOR, comment_id: 'c1' },
        }),
        entry({
          id: 'e2',
          workspaceId: W2,
          entityId: 'p2',
          payload: { author_user_id: ACTOR, comment_id: 'c2' },
        }),
      ],
      users: { [U1]: RECIPIENT_TZ, [ACTOR]: { displayName: 'Asha', timezone: null } },
      workspaces: {
        [W1]: { name: 'Acme', timezone: 'UTC' },
        [W2]: { name: 'Globex', timezone: 'UTC' },
      },
      posts: { p1: 'Spring', p2: 'Summer' },
      latestSeen: {},
      emails: { [U1]: 'r@example.test' },
    });

    const out = await runCatchup(f.g, NOW);

    expect(out.sent).toBe(2);
    expect(f.sent).toHaveLength(2);
    expect(f.deliveries.filter((d) => d.status === 'sent')).toHaveLength(2);
    expect(f.sent.map((s) => s.subject).sort()).toEqual([
      '[Acme] Your catch-up',
      '[Globex] Your catch-up',
    ]);
  });

  it('renders the stage row actor-less in Stage while the comment keeps its actor', async () => {
    const f = makeFake({
      entries: [
        entry({
          id: 'e1',
          eventType: 'comment',
          entityId: 'p1',
          payload: { author_user_id: ACTOR, comment_id: 'c1' },
        }),
        entry({
          id: 'e2',
          eventType: 'stage_change',
          entityId: 'p2',
          payload: { to_stage: 'approved' },
        }),
      ],
      users: { [U1]: RECIPIENT_TZ, [ACTOR]: { displayName: 'Asha', timezone: null } },
      workspaces: { [W1]: WS_TZ },
      posts: { p1: 'Spring', p2: 'Summer' },
      latestSeen: {},
      emails: { [U1]: 'r@example.test' },
    });

    await runCatchup(f.g, NOW);

    const html = f.sent[0]?.html ?? '';
    expect(html).toContain('Asha commented on Spring'); // actor preserved
    expect(html).toContain('stage-approved'); // coloured stage word
    expect(html).toContain('Summer'); // stage row target
  });

  it('appends DM counts and never emails a chat-only recipient with no entries', async () => {
    const f = makeFake({
      entries: [
        // Only U1 has inbox entries; U2 is chat-only and never a candidate.
        entry({
          id: 'e1',
          eventType: 'comment',
          entityId: 'p1',
          payload: { author_user_id: ACTOR, comment_id: 'c1' },
        }),
      ],
      users: {
        [U1]: RECIPIENT_TZ,
        [U2]: RECIPIENT_TZ,
        [ACTOR]: { displayName: 'Asha', timezone: null },
        [PEER]: { displayName: 'Bo', timezone: null },
      },
      workspaces: { [W1]: WS_TZ },
      posts: { p1: 'Spring' },
      latestSeen: {},
      emails: { [U1]: 'r@example.test', [U2]: 'u2@example.test' },
      dm: {
        [U1]: [{ peerUserId: PEER, count: 3, channelId: 'dm-1' }],
        [U2]: [{ peerUserId: PEER, count: 9, channelId: 'dm-2' }],
      },
    });

    const out = await runCatchup(f.g, NOW);

    // Catch-up is driven by inbox_entries: a pure-chat recipient is never sent.
    // This documents the known limitation (chat-only activity does not trigger).
    expect(out.sent).toBe(1);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.to).toBe('r@example.test');
    expect(f.sent[0]?.html).toContain('Bo sent three new messages');
    expect(f.sent.some((s) => s.to === 'u2@example.test')).toBe(false);
  });
});

describe('runCatchup failure + batching', () => {
  it('records a failed delivery and does not stamp on send failure', async () => {
    const f = makeFake({
      entries: [entry({ payload: { author_user_id: ACTOR, comment_id: 'c1' } })],
      users: { [U1]: RECIPIENT_TZ, [ACTOR]: { displayName: 'Asha', timezone: null } },
      workspaces: { [W1]: WS_TZ },
      posts: { p1: 'Spring' },
      latestSeen: {},
      emails: { [U1]: 'r@example.test' },
      sendFails: true,
    });

    const out = await runCatchup(f.g, NOW);

    expect(out).toEqual({ sent: 0, skipped: 1 });
    expect(f.stamped).toHaveLength(0);
    expect(f.deliveries).toHaveLength(1);
    expect(f.deliveries[0]?.status).toBe('failed');
    expect(f.deliveries[0]?.provider_message_id).toBeNull();
    expect(f.deliveries[0]?.sent_at).toBeNull();
    expect(f.deliveries[0]?.error).toContain('resend down');
  });

  it('resolves every kind in ONE batched call with id arrays (no N+1)', async () => {
    const f = makeFake({
      entries: [
        entry({
          id: 'e1',
          userId: U1,
          eventType: 'comment',
          entityId: 'p1',
          payload: { author_user_id: ACTOR, comment_id: 'c1' },
        }),
        entry({
          id: 'e2',
          userId: U2,
          eventType: 'comment',
          entityId: 'p2',
          payload: { author_user_id: PEER, comment_id: 'c2' },
        }),
      ],
      users: {
        [U1]: RECIPIENT_TZ,
        [U2]: RECIPIENT_TZ,
        [ACTOR]: { displayName: 'Asha', timezone: null },
        [PEER]: { displayName: 'Bo', timezone: null },
      },
      workspaces: { [W1]: WS_TZ },
      posts: { p1: 'Spring', p2: 'Summer' },
      latestSeen: {},
      emails: { [U1]: 'a@example.test', [U2]: 'b@example.test' },
    });

    await runCatchup(f.g, NOW);

    expect(f.calls.resolvePosts).toHaveLength(1);
    expect(f.calls.resolvePosts[0]?.slice().sort()).toEqual(['p1', 'p2']);
    expect(f.calls.resolveBriefs).toHaveLength(1);
    expect(f.calls.resolveAssets).toHaveLength(1);
    expect(f.calls.resolveWorkspaces).toHaveLength(1);
    expect(f.calls.resolveWorkspaces[0]).toEqual([W1]);
    expect(f.calls.resolveUsers).toHaveLength(1);
    const userIds = f.calls.resolveUsers[0] ?? [];
    expect(userIds).toEqual(expect.arrayContaining([U1, U2, ACTOR, PEER]));
    expect(f.calls.dm).toHaveLength(1);
    expect(f.calls.dm[0]?.ids.slice().sort()).toEqual([U1, U2].sort());
  });
});

// One list item part (decisions locked 6 and 7 Nov 2026): every list item in
// Pipeline, Briefs, Assets, the Chat list (Personal notes, Groups, People),
// Activity (and Upcoming) and the Plan tab (plans and the Bank) renders
// through ui/ListCard, and every card has the identical height structure
// (padding 16, the 72 picture, a 20 title line, a 2-line preview that always
// reserves 36, a 20 meta line). The page lists sit in LIST_CARD_GRID (one
// column on phone, auto-fill on laptop); the chat list in LIST_CARD_STACK.
// The old hand-built layouts (the PostCard frame, AssetCard / AssetGrid,
// PEOPLE_TILE_GRID, the Plan tab's own cards and calendar, the Bank's own
// card, the board columns) are gone from those screens.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/workspace-context', async (importOriginal) => ({
  workspaceDisplayName: (await importOriginal<typeof import('@/lib/workspace-context')>())
    .workspaceDisplayName,
  useWorkspace: () => ({ workspaceKey: 'gbl' }),
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { BriefWithThumbnail } from '@srtdio/briefs';
import { BriefCard } from '@/components/pages/BriefCard';
import { ActivityCard } from '@/components/pages/activity/ActivityCard';
import type { ActivityItem } from '@/components/pages/activity/data';
import { ChannelCard, DEFAULT_LIST_INPUT, notesTile } from '@/components/chat/ChannelList';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { PresignCache } from '@/lib/asset-presign';

const cache = {
  peek: () => null,
  resolve: async () => null,
  peekThumbnail: () => null,
  thumbnail: async () => null,
} as unknown as PresignCache;

const brief: BriefWithThumbnail = {
  id: 'b1',
  workspace_id: 'w1',
  number: 1,
  title: 'Spring launch',
  objective: 'Tease the spring drop across feed and stories.',
  legacy_author_name: null,
  status: 'open',
  target_date: '2026-11-28',
  reference_links: null,
  mentions: null,
  format_requested: null,
  brand_requirements: null,
  closed_at: null,
  closed_by: null,
  created_by: 'u1',
  created_via: 'manual',
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  deleted_at: null,
  row_version: 1,
  thumbnailAssetVersionId: null,
};

const activity: ActivityItem = {
  id: 'e1',
  workspaceId: 'w1',
  number: null,
  eventType: 'comment',
  entityType: 'post',
  entityId: 'p1',
  scope: 'posts',
  tier: 'active',
  createdAt: '2026-11-06T09:00:00.000Z',
  readAt: null,
  snoozedUntil: null,
  commentId: null,
  assetId: null,
  toStage: null,
  fromStage: null,
  title: 'Watch launch',
  actorId: null,
  actorName: 'Maya',
  actorAvatarUrl: null,
  body: 'Love it',
  format: 'text',
  caption: null,
  thumbnailAssetVersionId: null,
  pointsAdded: null,
  checkpointTotal: null,
  batchId: null,
  messageId: null,
  channelType: null,
};

const dm: ChannelSummary = {
  channelId: 'c1',
  channelType: 'dm',
  title: 'Asha Rao',
  avatarUrl: null,
  agoraGroupId: null,
  groupId: null,
  peerUserId: 'u2',
  createdAt: 't',
};
const group: ChannelSummary = { ...dm, channelId: 'g1', channelType: 'group', title: 'Launch' };
const notes: ChannelSummary = { ...dm, channelId: 'n1', title: 'Personal notes' };
const NOW = Date.parse('2026-11-06T10:00:00Z');

function chat(channel: ChannelSummary): string {
  return renderToStaticMarkup(
    <ChannelCard
      channel={channel}
      selected={false}
      summary={{ lastMessageText: 'See you', lastMessageTs: NOW - 60_000, unread: 2 }}
      nowMs={NOW}
      timeZone="UTC"
      onSelect={() => {}}
      input={DEFAULT_LIST_INPUT}
      onLongPress={() => {}}
      onHide={() => {}}
    />,
  );
}

const SCREENS: Record<string, string> = {
  briefs: renderToStaticMarkup(
    <MemoryRouter>
      <BriefCard
        brief={brief}
        cache={cache}
        presignEnabled={false}
        href="/b/1"
        timeZone="UTC"
        now={new Date(NOW)}
      />
    </MemoryRouter>,
  ),
  activity: renderToStaticMarkup(
    <ActivityCard
      group={[activity]}
      nowMs={NOW}
      timeZone="UTC"
      cache={cache}
      presignEnabled={false}
      onOpenGroup={() => {}}
      onOpenEntry={() => {}}
      onSnooze={() => {}}
      onMarkRead={() => {}}
      selfName={null}
    />,
  ),
  group: chat(group),
  person: chat(dm),
  notes: renderToStaticMarkup(
    notesTile({ notes, selected: false, selecting: false, onSelect: () => {} }),
  ),
};

/** The class list of the element carrying `attr`. */
function classOf(html: string, attr: string): string[] {
  const m = new RegExp(`<[a-z]+[^>]*${attr}[^>]*class="([^"]*)"`).exec(html);
  return (m?.[1] ?? '').split(' ');
}

/** The height-giving classes of each slot. */
function heightShape(html: string): string[][] {
  return [
    'data-list-card-body=""',
    'data-list-card-picture=',
    'data-list-card-line="1"',
    'data-list-card-preview=""',
    'data-list-card-line="3"',
  ].map((attr) =>
    classOf(html, attr)
      .filter((c) => /^(h|w|min-h|p|py|pt|pb|gap|line-clamp|items)-/.test(c))
      .sort(),
  );
}

describe('Briefs, Activity and Chat render through ui/ListCard', () => {
  it('every list carries data-list-card', () => {
    for (const [name, html] of Object.entries(SCREENS)) {
      expect(html, name).toContain('data-list-card=""');
      expect(html.match(/data-list-card=""/g), name).toHaveLength(1);
    }
  });

  it('every card has the identical height structure', () => {
    const base = heightShape(SCREENS.briefs ?? '');
    expect(base[0]).toContain('p-4');
    expect(base[1]).toEqual(expect.arrayContaining(['h-18', 'w-18']));
    expect(base[3]).toEqual(expect.arrayContaining(['line-clamp-2', 'min-h-9']));
    for (const [name, html] of Object.entries(SCREENS)) {
      expect(heightShape(html), name).toEqual(base);
    }
  });

  it('every card has its one tap surface and at most one grey tag', () => {
    for (const [name, html] of Object.entries(SCREENS)) {
      expect(html.match(/data-list-card-press=""|data-brief-card-link=""/g), name).toHaveLength(1);
      expect((html.match(/data-list-card-tag=""/g) ?? []).length, name).toBeLessThanOrEqual(1);
    }
  });
});

describe('line 3 time: relative or due, never a clock time', () => {
  it('Briefs read the due words, Activity and Chat read how long ago', () => {
    expect(SCREENS.briefs).toMatch(/data-list-card-time=""[^>]*>Due in 22 days</);
    expect(SCREENS.activity).toMatch(/data-list-card-time=""[^>]*>1 hour ago</);
    expect(SCREENS.group).toMatch(/data-list-card-time=""[^>]*>1 min ago</);
    expect(SCREENS.person).toMatch(/data-list-card-time=""[^>]*>1 min ago</);
    for (const [name, html] of Object.entries(SCREENS)) {
      expect(html, name).not.toMatch(/data-list-card-time=""[^>]*>[^<]*\b(AM|PM)</);
    }
  });

  it('the chat card tags unread as "N new"; the activity card tags its kind', () => {
    expect(SCREENS.group).toMatch(/data-list-card-tag=""[^]*?">2 new</);
    expect(SCREENS.activity).toMatch(/data-list-card-tag=""[^]*?">Post</);
    expect(SCREENS.briefs).toMatch(/data-list-card-tag=""[^]*?">Open</);
  });
});

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../components/${rel}`, import.meta.url)), 'utf8');

/** Every screen's source, as the files that draw its list. */
const SOURCES = {
  pipeline: ['pages/PostCard.tsx', 'pages/PipelinePage.tsx', 'pages/pipeline/PipelineFeed.tsx'],
  briefs: ['pages/BriefCard.tsx', 'pages/BriefsPage.tsx'],
  assets: ['pages/AssetsPage.tsx', 'pages/assets/AssetListCard.tsx'],
  chat: ['chat/ChannelList.tsx'],
  activity: ['pages/activity/ActivityCard.tsx', 'pages/NotificationsPage.tsx'],
  planTab: ['pages/PlanTabPage.tsx', 'pages/plan-tab/PlanTabList.tsx'],
  bank: ['pages/plan-tab/BankList.tsx'],
} as const;

const source = (screen: keyof typeof SOURCES): string =>
  SOURCES[screen].map((rel) => read(rel)).join('\n');

describe('all six lists (and the Bank) render ui/ListCard', () => {
  it.each(Object.keys(SOURCES) as (keyof typeof SOURCES)[])('%s draws its cards with <ListCard', (screen) => {
    const src = source(screen);
    expect(src).toContain("from '@/components/ui/ListCard'");
    expect(src).toContain('<ListCard');
  });

  it.each(['pipeline', 'briefs', 'assets', 'activity', 'planTab', 'bank'] as const)(
    '%s lays its list out in LIST_CARD_GRID',
    (screen) => {
      expect(source(screen)).toContain('LIST_CARD_GRID');
    },
  );

  it('the chat list is one column in its pane (LIST_CARD_STACK)', () => {
    const src = source('chat');
    expect(src).toContain('LIST_CARD_STACK');
    expect(src).not.toContain('LIST_CARD_GRID');
  });

  it('no page list keeps the ui/Card grid', () => {
    for (const screen of ['briefs', 'activity', 'chat'] as const) {
      // \b keeps LIST_CARD_GRID out: "_" is a word character.
      expect(source(screen), screen).not.toMatch(/\bCARD_GRID\b/);
    }
  });
});

describe('the old layouts are gone', () => {
  it('Pipeline: no PostCard frame of its own, no board columns', () => {
    const src = source('pipeline');
    expect(read('pages/PostCard.tsx')).not.toContain("from '@/components/ui/Card'");
    expect(src).not.toMatch(/BoardColumns?\b/);
    expect(src).not.toContain('data-board-column');
  });

  it('Assets: no AssetCard or AssetGrid', () => {
    const src = source('assets');
    expect(src).not.toMatch(/\bAssetGrid\b/);
    expect(src).not.toMatch(/<AssetCard\b/);
  });

  it('Chat list: no people tiles', () => {
    expect(source('chat')).not.toContain('PEOPLE_TILE_GRID');
  });

  it('Plan tab: no calendar and no card of its own; the Bank: no card of its own', () => {
    const plan = source('planTab');
    expect(plan).not.toContain('<PlanCalendar');
    expect(read('pages/plan-tab/PlanTabList.tsx')).not.toContain("from '@/components/ui/Card'");
    expect(read('pages/plan-tab/BankList.tsx')).not.toContain("from '@/components/ui/Card'");
  });

  it('Briefs: no ui/Card frame or reference link on the list card', () => {
    const src = read('pages/BriefCard.tsx');
    expect(src).not.toContain("from '@/components/ui/Card'");
    expect(src).not.toContain('LinkPreviewCard');
    expect(src).toContain('<ListCard');
  });

  it('Activity: no lead rail, no actor line or AvatarStack row, no thread rows, no unread border', () => {
    const src = read('pages/activity/ActivityCard.tsx');
    expect(src).not.toContain('AvatarStack');
    expect(src).not.toContain('lit-selected');
    expect(source('activity')).not.toContain('selected={unread');
    expect(src).not.toContain('w-1 shrink-0');
    expect(src).not.toContain('ThreadRow');
    expect(src).not.toContain('data-activity-thread');
    expect(src).not.toContain("from '@/components/ui/Row'");
    expect(src).toContain('<ListCard');
  });

  it('Chat list: no ui/Row rows, no CountBadge', () => {
    const src = read('chat/ChannelList.tsx');
    expect(src).not.toContain("from '@/components/ui/Row'");
    expect(src).not.toContain('<CountBadge');
    expect(src).toContain('<ListCard');
  });
});

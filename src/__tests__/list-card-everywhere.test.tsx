// One list item part (decisions locked 6 and 7 Nov 2026): every list item in
// Pipeline, Briefs, Assets, the Chat list (Personal notes, Groups, People),
// Activity and the Plan tab (plans and the Bank) renders
// through ui/ListCard, and every card has the identical height structure
// (the flat density row bled 16 each side: h-18 72 Cozy, compact:h-15 60,
// calm:h-20 80; the 48 picture, 40 in Compact; a 20 title + time line, a 20
// preview + tag + unread line; density 8 Nov 2026). The page lists sit in LIST_CARD_GRID (one
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

import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { BriefWithThumbnail } from '@srtdio/briefs';
import { BriefCard } from '@/components/pages/BriefCard';
import { ActivityCard } from '@/components/pages/activity/ActivityCard';
import type { ActivityItem } from '@/components/pages/activity/data';
import { ChannelCard, DEFAULT_LIST_INPUT, notesTile } from '@/components/chat/ChannelList';
import { PostCard } from '@/components/pages/PostCard';
import { AssetListCard } from '@/components/pages/assets/AssetListCard';
import { PlanTabCard } from '@/components/pages/plan-tab/PlanTabList';
import { bankCardPicture } from '@/components/pages/plan-tab/BankList';
import { LIST_CARD_BODY, LIST_CARD_PICTURE, ListCard } from '@/components/ui/ListCard';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { PresignCache } from '@/lib/asset-presign';
import type { AssetListItem } from '@/lib/assets';
import type { BankIdea, PlanBundle } from '@/lib/chat/plans';
import type { PipelinePost } from '@srtdio/posts';
import tailwindConfig from '../../tailwind.config';

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
    />,
  );
}

const post: PipelinePost = {
  id: 'p1',
  number: 1,
  title: 'Watch launch',
  platform: 'instagram',
  format: 'text',
  caption: 'Tease the drop',
  target_date: '2026-11-09T12:00:00Z',
  stage: 'review',
  origin: 'manual',
  legacy_author_name: null,
  bucket_id: null,
  brief_id: null,
  owner_user_id: 'u1',
  created_by: 'u1',
  workspace_id: 'w1',
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-01T00:00:00Z',
  stage_entered_at: '2026-11-01T00:00:00Z',
  approved_by: null,
  approved_on_behalf_of: null,
  approved_at: null,
  deleted_at: null,
  row_version: 1,
  thumbnailAssetVersionId: null,
};

const asset: AssetListItem = {
  id: 'a1',
  filename: 'report.pdf',
  displayName: null,
  folderPath: '/',
  folderId: null,
  tags: [],
  uploadedAt: '2026-11-02T09:00:00Z',
  currentVersionId: 'av1',
  kind: 'pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  width: null,
  height: null,
  durationMs: null,
  pageCount: null,
  externalUrl: null,
  r2Key: null,
  versionNumber: 1,
  attachmentCount: 0,
};

const plan: PlanBundle = {
  plan: {
    id: 'pl1',
    workspace_id: 'w1',
    title: 'Festive season',
    starts_on: '2026-11-06',
    ends_on: '2026-11-12',
    audience: 'client',
    created_by: null,
  },
  items: [],
  reviews: [],
  postStages: {},
  postInfo: {},
};

const SCREENS: Record<string, string> = {
  pipeline: renderToStaticMarkup(
    <MemoryRouter>
      <PostCard
        post={post}
        cache={cache}
        presignEnabled={false}
        now={new Date(NOW)}
        timeZone="UTC"
      />
    </MemoryRouter>,
  ),
  assets: renderToStaticMarkup(
    <AssetListCard
      item={asset}
      cache={cache}
      presignEnabled={false}
      now={new Date(NOW)}
      onOpen={() => {}}
    />,
  ),
  planTab: renderToStaticMarkup(
    <MemoryRouter>
      <PlanTabCard
        bundle={plan}
        cover={null}
        timeZone="UTC"
        now={new Date(NOW)}
        onOpen={() => {}}
      />
    </MemoryRouter>,
  ),
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
    'data-list-card=""',
    'data-list-card-body=""',
    'data-list-card-picture=',
    'data-list-card-line="1"',
    'data-list-card-line="2"',
  ].map((attr) =>
    classOf(html, attr)
      .filter((c) =>
        /^(compact:|calm:)?(-?mx|h|w|min-h|p|px|py|pt|pb|gap|line-clamp|items)-/.test(c),
      )
      .sort(),
  );
}

describe('Pipeline, Briefs, Assets, Chat, Activity and the Plan tab render through ui/ListCard', () => {
  it('every list carries data-list-card', () => {
    for (const [name, html] of Object.entries(SCREENS)) {
      expect(html, name).toContain('data-list-card=""');
      expect(html.match(/data-list-card=""/g), name).toHaveLength(1);
    }
  });

  it('every card has the identical height structure', () => {
    const base = heightShape(SCREENS.briefs ?? '');
    expect(base[0]).toEqual(
      expect.arrayContaining(['-mx-4', 'h-18', 'compact:h-15', 'calm:h-20', 'px-4']),
    );
    expect(base[1]).not.toContain('p-3');
    expect(base[2]).toEqual(
      expect.arrayContaining(['h-12', 'w-12', 'compact:h-10', 'compact:w-10']),
    );
    expect(base[3]).toContain('h-5');
    expect(base[4]).toContain('h-5');
    for (const [name, html] of Object.entries(SCREENS)) {
      expect(heightShape(html), name).toEqual(base);
    }
  });

  it('covers all six lists: Pipeline, Briefs, Assets, the Chat list, Activity, the Plan tab', () => {
    expect(Object.keys(SCREENS)).toEqual(
      expect.arrayContaining(['pipeline', 'briefs', 'assets', 'group', 'activity', 'planTab']),
    );
  });

  it('every card has its one tap surface and at most one grey tag', () => {
    for (const [name, html] of Object.entries(SCREENS)) {
      expect(
        html.match(/data-list-card-press=""|data-[a-z-]+-link=""[^>]*class="absolute inset-0/g),
        name,
      ).toHaveLength(1);
      expect((html.match(/data-list-card-tag=""/g) ?? []).length, name).toBeLessThanOrEqual(1);
    }
  });
});

describe('line 1 time: by meaning (due, ago, added, plan), words only, never a clock time on a past day', () => {
  it('Pipeline and Briefs read the due words, Activity and Chat read how long ago', () => {
    expect(SCREENS.pipeline).toMatch(/data-list-card-time=""[^>]*>Mon</);
    expect(SCREENS.briefs).toMatch(/data-list-card-time=""[^>]*>28 Nov</);
    expect(SCREENS.activity).toMatch(/data-list-card-time=""[^>]*>1h</);
    expect(SCREENS.group).toMatch(/data-list-card-time=""[^>]*>1m</);
    expect(SCREENS.person).toMatch(/data-list-card-time=""[^>]*>1m</);
    expect(SCREENS.assets).toMatch(/data-list-card-time=""[^>]*>2 Nov</);
    expect(SCREENS.planTab).toMatch(/data-list-card-time=""[^>]*>Today</);
    for (const [name, html] of Object.entries(SCREENS)) {
      expect(html, name).not.toMatch(/data-list-card-time=""[^>]*>[^<]*\b(AM|PM)</);
      // The long forms are gone ("5 min ago", "Due in 3 days", "Overdue 2 days").
      expect(html, name).not.toMatch(/\b(min|hours?|days?) ago\b|Due in \d|Overdue \d+ days?\b/);
      // Words only: never "Due", "Overdue", "Starts" or "Started" on a card.
      expect(html, name).not.toMatch(/data-list-card-time=""[^>]*>(Due|Overdue|Starts?|Started)\b/);
    }
  });

  it('line 1 is title then time; line 2 is preview, tag, unread dot; no line 3, no ⋮', () => {
    for (const [name, html] of Object.entries(SCREENS)) {
      const one = html.slice(
        html.indexOf('data-list-card-line="1"'),
        html.indexOf('data-list-card-line="2"'),
      );
      const order1 = [...one.matchAll(/data-list-card-(title|time)=""/g)].map((m) => m[1]);
      expect(order1[0], name).toBe('title');
      const two = html.slice(html.indexOf('data-list-card-line="2"'));
      const order2 = [...two.matchAll(/data-list-card-(preview|tag|unread)=""/g)].map((m) => m[1]);
      expect(order2.join(','), name).toMatch(/^(preview,?)?(tag,?)?(unread)?$/);
      expect(html, name).not.toContain('data-list-card-line="3"');
      expect(html, name).not.toContain('data-list-card-more');
      expect(html, name).not.toContain('aria-haspopup="menu"');
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
  it.each(Object.keys(SOURCES) as (keyof typeof SOURCES)[])(
    '%s draws its cards with <ListCard',
    (screen) => {
      const src = source(screen);
      expect(src).toContain("from '@/components/ui/ListCard'");
      expect(src).toContain('<ListCard');
    },
  );

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

const spacing = tailwindConfig.theme?.spacing as Record<string, string>;
const px = (rem: string): number => parseFloat(rem) * 16;

describe('equal height: the density row on every list (Pipeline, Briefs, Assets, Chat, Activity, Plan tab, Bank)', () => {
  it.each([
    ['cozy', '18', '12', '3', 72, 48, 12],
    ['compact', '15', '10', 'row-inset', 60, 40, 10],
    ['calm', '20', '12', '4', 80, 48, 16],
  ] as const)(
    'the arithmetic, %s: inset + picture + inset = the row, the 44 text column centred inside, no border',
    (_density, rowStep, pictureStep, insetStep, rowPx, picturePx, insetPx) => {
      const padding = tailwindConfig.theme?.extend?.padding as Record<string, string>;
      const row = px(spacing[rowStep] ?? '');
      const picture = px(spacing[pictureStep] ?? '');
      const inset = px(spacing[insetStep] ?? padding[insetStep] ?? '');
      const line = px(spacing['5'] ?? '');
      const gap = px(spacing['1'] ?? '');
      expect(row).toBe(rowPx);
      expect(picture).toBe(picturePx);
      expect(inset).toBe(insetPx);
      const text = line + gap + line;
      expect(text).toBe(44);
      expect(inset + picture + inset).toBe(row);
      expect(text).toBeLessThanOrEqual(row);
      expect((row - picture) / 2).toBe(inset);
    },
  );

  it('picture 48 (40 Compact) at 16 from the bled row edge (the frame px-4), 12 to the text', () => {
    expect(LIST_CARD_BODY.split(' ')).toContain('gap-3');
    expect(LIST_CARD_BODY.split(' ')).not.toContain('p-3');
    for (const [name, html] of Object.entries(SCREENS)) {
      expect(html, name).toMatch(/data-list-card-body=""[^>]*><span data-list-card-picture=/);
    }
  });

  it('the Bank card is the same part and the same shape', () => {
    const idea = {
      id: 'i1',
      title: 'Behind the scenes',
      description: 'Studio day',
      thumb: null,
      file_count: 0,
    } as unknown as BankIdea;
    const html = renderToStaticMarkup(
      <ListCard
        picture={bankCardPicture(idea)}
        title="Behind the scenes"
        preview="Studio day"
        time="2 Nov"
        tag="Reels"
        onPress={() => {}}
      />,
    );
    expect(heightShape(html)).toEqual(heightShape(SCREENS.briefs ?? ''));
    expect(source('bank')).toContain('picture={bankCardPicture(idea)}');
  });
});

describe('S3: the picture box is 48x48 (40 in Compact) whatever the picture, before and after it arrives', () => {
  it('every picture kind keeps h-12 w-12 compact:h-10 compact:w-10 shrink-0 on the slot', () => {
    const slot = ['h-12', 'w-12', 'compact:h-10', 'compact:w-10', 'shrink-0'];
    expect(LIST_CARD_PICTURE.split(' ')).toEqual(expect.arrayContaining(slot));
    for (const [name, html] of Object.entries(SCREENS)) {
      expect(classOf(html, 'data-list-card-picture='), name).toEqual(expect.arrayContaining(slot));
    }
  });

  it('an image that has not arrived (no peek) and one that has hold the same slot classes', () => {
    const slot = (node: ReactElement): string[] =>
      classOf(
        renderToStaticMarkup(
          <ListCard picture={{ kind: 'image', node }} title="T" preview="P" time="1m" />,
        ),
        'data-list-card-picture=',
      ).sort();
    const pending = slot(<span data-pending="" />);
    const arrived = slot(<img src="https://cdn/x.png" alt="" width={1600} height={400} />);
    expect(arrived).toEqual(pending);
    expect(pending).toEqual(
      expect.arrayContaining(['h-12', 'w-12', 'compact:h-10', 'compact:w-10', 'shrink-0']),
    );
  });

  it('zero layout shift: the image fills the box and never sizes it (a 1600x400 picture stays 48, 40 in Compact)', () => {
    const html = renderToStaticMarkup(
      <ListCard
        picture={{
          kind: 'image',
          node: <img src="https://cdn/x.png" alt="" width={1600} height={400} />,
        }}
        title="T"
      />,
    );
    const wrapper =
      /data-list-card-picture-box=""[^>]*><span class="([^"]*)"/.exec(html)?.[1] ?? '';
    const decoded = wrapper.replace(/&amp;/g, '&').replace(/&gt;/g, '>');
    expect(decoded.split(' ')).toEqual(
      expect.arrayContaining(['h-full', 'w-full', '[&>*]:h-full', '[&>*]:w-full']),
    );
    expect(classOf(html, 'data-list-card-picture=')).toContain('shrink-0');
  });
});

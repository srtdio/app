// One list item part (decision locked 6 Nov 2026): every list item in Briefs,
// Activity (and Upcoming) and the Chat list (Personal notes, Groups, People)
// renders through ui/ListCard, and every card has the identical height
// structure (padding 16, the 72 picture, a 20 title line, a 2-line preview
// that always reserves 36, a 20 meta line). The old hand-built layouts are gone.
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
      <BriefCard brief={brief} cache={cache} presignEnabled={false} href="/b/1" timeZone="UTC" />
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

describe('the old layouts are gone', () => {
  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(`../components/${rel}`, import.meta.url)), 'utf8');

  it('Briefs: no ui/Card frame or reference link on the list card', () => {
    const src = read('pages/BriefCard.tsx');
    expect(src).not.toContain("from '@/components/ui/Card'");
    expect(src).not.toContain('LinkPreviewCard');
    expect(src).toContain('<ListCard');
  });

  it('Activity: no lead rail, no actor line, no thread rows', () => {
    const src = read('pages/activity/ActivityCard.tsx');
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

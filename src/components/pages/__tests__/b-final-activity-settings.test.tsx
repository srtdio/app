// B-final (Activity, Settings, Members): the screens sit on the parts. Slots
// (ui/Row for thread rows, member rows and the member sheet's person), the
// trailing rule (every trailing ⋯ is ActionMenuTrigger with TRAILING_PULL, so
// its glyph ends on the content edge), and rows that keep one height across
// states (menu, lock, nothing; with or without Mark all read).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
// ActionMenu picks popover vs Sheet by width; the node env has no matchMedia.
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
}));
vi.mock('@/lib/supabase', () => ({ supabase: { functions: { invoke: vi.fn() } } }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 't-1' }));
vi.mock('@/lib/workspace-context', async (importOriginal) => ({
  workspaceDisplayName: (await importOriginal<typeof import('@/lib/workspace-context')>())
    .workspaceDisplayName,
  useWorkspace: () => ({ workspaceId: 'ws-1', workspaceKey: 'gbl' }),
}));
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityCard } from '@/components/pages/activity/ActivityCard';
import type { ActivityItem } from '@/components/pages/activity/data';
import { getInviteRoleOptions } from '@/components/pages/settings/MembersInviteForm';
import {
  EMAIL_OFF_LABEL,
  EMAIL_ON_LABEL,
  MembersList,
  type PendingEditHandler,
} from '@/components/pages/settings/MembersList';
import type { MemberEntry } from '@/components/pages/settings/members-data';
import { Row } from '@/components/ui/Row';
import { TRAILING_PULL } from '@/components/ui/layout';
import type { PresignCache } from '@/lib/asset-presign';

const cache = {} as unknown as PresignCache;

function item(over: Partial<ActivityItem>): ActivityItem {
  return {
    id: 'e1',
    workspaceId: 'w1',
    number: null,
    eventType: 'comment',
    entityType: 'post',
    entityId: 'p1',
    scope: 'posts',
    tier: 'active',
    createdAt: '2026-06-14T00:00:00.000Z',
    readAt: null,
    snoozedUntil: null,
    commentId: null,
    assetId: null,
    toStage: null,
    fromStage: null,
    title: null,
    actorId: null,
    actorName: null,
    actorAvatarUrl: null,
    body: null,
    format: null,
    caption: null,
    thumbnailAssetVersionId: null,
    pointsAdded: null,
    checkpointTotal: null,
    batchId: null,
    messageId: null,
    channelType: null,
    ...over,
  };
}

const NOW = Date.parse('2026-06-14T01:00:00.000Z');

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
}

/** The class list of the element that carries `attr` (first match). */
function classOf(html: string, attr: string): string {
  const at = html.indexOf(attr);
  expect(at).toBeGreaterThanOrEqual(0);
  const tagStart = html.lastIndexOf('<', at);
  const tag = html.slice(tagStart, html.indexOf('>', at));
  return /class="([^"]*)"/.exec(tag)?.[1] ?? '';
}

function member(over: Partial<MemberEntry>): MemberEntry {
  return {
    id: 'm-0',
    userId: 'u-0',
    role: 'agency',
    displayName: 'Ada Agency',
    avatarUrl: null,
    email: 'ada@agency.test',
    acceptedAt: '2026-01-01T00:00:00Z',
    isOwner: false,
    isSelf: false,
    ...over,
  };
}

function listProps(
  over: Partial<ComponentProps<typeof MembersList>> = {},
): ComponentProps<typeof MembersList> {
  return {
    derived: {
      agency: [
        member({
          id: 'm-o',
          userId: 'u-o',
          displayName: 'Olive Owner',
          role: 'owner',
          isOwner: true,
        }),
        member({ id: 'm-a', userId: 'u-a', emailOptIn: true }),
        member({
          id: 'm-b',
          userId: 'u-b',
          displayName: 'Bo Admin',
          role: 'admin',
          emailOptIn: false,
        }),
      ],
      client: [],
      pending: [],
    },
    clientName: 'Acme',
    canManage: true,
    cancellingId: null,
    delivery: new Map(),
    pendingEmails: new Map(),
    roleOptions: getInviteRoleOptions(false),
    onChangeRole: vi.fn(),
    onRemove: vi.fn(),
    onCancelInvite: vi.fn(),
    onEditInvite: vi.fn<PendingEditHandler>(async () => null),
    ...over,
  };
}

describe('Activity: the day line and the card with no trailing ⋯', () => {
  it('"YESTERDAY · 1 update" and Mark all read share one 44 line; no avatar beside the label', () => {
    const page = src('pages/NotificationsPage.tsx');
    expect(page).toMatch(/data-activity-bucket-head=""[\s\S]{0,120}?h-11/);
    expect(page).toMatch(
      /data-activity-bucket-head[\s\S]*?data-bucket-count[\s\S]*?data-activity-mark-all/,
    );
    expect(page).not.toContain('AvatarStack');
  });

  it('the card has no ⋯ at all; the ListCard body is the 12 inset', () => {
    const html = renderToStaticMarkup(
      <ActivityCard
        group={[item({ id: 'a' })]}
        nowMs={NOW}
        cache={cache}
        presignEnabled={false}
        onOpenGroup={() => {}}
        onOpenEntry={() => {}}
        selfName={null}
      />,
    );
    expect(html).not.toContain('Activity options');
    expect(html).not.toContain('data-activity-menu');
    expect(html).not.toContain(TRAILING_PULL);
    // The ListCard body is the 12 inset (no 14px one-offs left).
    expect(html).toContain('data-list-card=""');
    expect(html).toMatch(/data-list-card-body="" class="[^"]*\bp-3\b/);
    expect(html).not.toMatch(/data-list-card-body="" class="[^"]*\bp-4\b/);
    expect(html).not.toContain('[14px]');
  });
});

describe('Members: ui/Row, role tag only, the mail mark, the trailing rule', () => {
  const html = renderToStaticMarkup(<MembersList {...listProps()} />);

  it('every member row is a ui/Row, one height whatever its trailing (⋯, lock)', () => {
    expect(html.match(/data-member-row=/g)).toHaveLength(3);
    // Each row has an email line: all three are the 72 row, menu or lock alike.
    expect(html.match(/min-h-18/g)).toHaveLength(3);
  });

  it('the ⋯ sits in the Row trailing slot and takes TRAILING_PULL', () => {
    expect(html.match(/data-row-more=""/g)).toHaveLength(2);
    expect(classOf(html, 'aria-label="Actions for Ada Agency"').split(' ')).toContain(
      TRAILING_PULL,
    );
  });

  it('the role is the one tag; email status is a small grey mail mark with a name', () => {
    expect(html).toContain('>Creator<');
    expect(html).not.toContain('>On<');
    expect(html).not.toContain('>Emails off<');
    expect(html).toContain(`aria-label="${EMAIL_ON_LABEL}"`);
    expect(html).toContain(`aria-label="${EMAIL_OFF_LABEL}"`);
    expect(classOf(html, 'data-member-email-mark="on"')).toContain('text-fg-3');
  });

  it('the group label sits on the page edge above its card', () => {
    const at = html.indexOf('>Approvers<');
    const card = html.indexOf('data-members-group=""');
    expect(at).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(at);
  });
});

describe('Row flush slot (additive)', () => {
  it('default keeps the 16 inset and the 60 divider; flush drops the inset', () => {
    const plain = renderToStaticMarkup(<Row title="A" divider />);
    expect(plain).toContain('px-4');
    expect(plain).toContain('left-15');
    const flush = renderToStaticMarkup(<Row title="A" divider flush />);
    expect(flush).toContain('px-0');
    expect(flush).not.toContain('px-4');
    expect(flush).toContain('left-11');
  });
});

describe('Settings: one content width', () => {
  it('the page sets one laptop width; no panel sets its own', () => {
    expect(src('pages/SettingsPage.tsx')).toContain('md:max-w-2xl');
    for (const rel of [
      'pages/settings/WorkspaceSettingsPanel.tsx',
      'pages/settings/MembersList.tsx',
      'pages/settings/MembersInviteForm.tsx',
      'pages/settings/StoragePanel.tsx',
      'settings/ProfileSettingsPanel.tsx',
    ]) {
      expect(src(rel)).not.toMatch(/max-w-\[(520|720|544)px\]/);
    }
  });
});

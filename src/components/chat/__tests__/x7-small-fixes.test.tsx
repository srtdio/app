// X7 fixes 8-10: names and copy (FT43, FT44), 44px ticker targets (FT45),
// the group header (FT46), notes empty state (FN22), the small copy and input
// fixes (FN23) and skeletons for plain "Loading" lines (FN24).
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The chat modules' import graph pulls the agora-chat browser SDK; mock it.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: 'w1', workspaceKey: 'w1', workspaces: [] }),
}));
vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => false }));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'me' } }, loading: false }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  NOTES_EMPTY_LINE,
  NOTES_EMPTY_TITLE,
  reactionBadgeLabel,
} from '@/components/chat/MessageThread';
import {
  GROUP_INFO_ADMIN_ONLY,
  GROUP_PHOTO_UNAVAILABLE,
  GROUP_PHOTO_UNREADABLE,
  GROUP_PHOTO_UPLOAD_FAILED,
  canEditGroupInfo,
} from '@/components/chat/GroupInfoSheet';
import { SCHEDULING_LABEL } from '@/components/chat/Composer';
import { CANCEL_CONFIRM_TITLE, DONT_SEND_LABEL } from '@/components/chat/ScheduledListSheet';
import { BAR_INPUT } from '@/components/chat/InChatSearchBar';
import { listSkeleton } from '@/components/chat/ListSkeleton';
import { nextMenuIndex } from '@/lib/chat/menu-keys';

const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

describe('X7 FT44: reaction badge name', () => {
  it('names each emoji with its count and the total', () => {
    expect(
      reactionBadgeLabel([
        { emoji: '👍', count: 2 },
        { emoji: '❤️', count: 1 },
      ]),
    ).toBe('Reactions: 👍 2, ❤️ 1. 3 in total. Show who reacted');
    expect(source('../MessageThread.tsx')).toContain(
      'aria-label={reactionBadgeLabel(message.reactions)}',
    );
  });
});

describe('X7 FT43: group info admin copy matches the creator-or-admin rule', () => {
  it('names the creator as well as admins', () => {
    expect(GROUP_INFO_ADMIN_ONLY).toBe(
      "Only the group's creator or an admin can edit this group's info",
    );
    expect(canEditGroupInfo({ currentUserId: 'u1', creatorId: 'u1', role: 'member' })).toBe(true);
    expect(canEditGroupInfo({ currentUserId: 'u1', creatorId: 'u2', role: 'admin' })).toBe(true);
    expect(canEditGroupInfo({ currentUserId: 'u1', creatorId: 'u2', role: 'member' })).toBe(false);
  });
});

describe('X7 FT45: status ticker targets', () => {
  it('items and the chevron are real 44px buttons', () => {
    const ticker = source('../StatusTicker.tsx');
    expect(ticker).toContain('"relative -my-1 h-11 before:absolute');
    expect(ticker).toContain('className="relative -my-1 flex h-11 w-4');
  });
});

describe('X7 FT46: group header', () => {
  it('no Info icon (the identity tap opens Group info); Starred moves into Group info', () => {
    const thread = source('../MessageThread.tsx');
    expect(thread).not.toContain('<IconButton label="Group info"');
    expect(thread).toContain('!groupInfoInHeader ? (');
    expect(thread).toContain(
      'const groupInfoInHeader = props.isGroup === true && props.onOpenInfo !== undefined;',
    );
  });
});

describe('X7 FN22-FN24: copy, inputs and skeletons', () => {
  it('notes empty state', () => {
    expect(NOTES_EMPTY_TITLE).toBe('Your private notes live here.');
    expect(NOTES_EMPTY_LINE).not.toMatch(/—/);
  });

  it('"Scheduling…" with the ellipsis, "Don\'t send" on scheduled cards', () => {
    expect(SCHEDULING_LABEL).toBe('Scheduling…');
    expect(DONT_SEND_LABEL).toBe("Don't send");
    expect(CANCEL_CONFIRM_TITLE).toBe("Don't send this message?");
    expect(source('../ScheduledListSheet.tsx')).not.toContain('Cancel message');
  });

  it('in-chat search input is 16px on a phone', () => {
    expect(BAR_INPUT.split(' ')).toEqual(expect.arrayContaining(['text-input', 'md:text-base']));
    expect(BAR_INPUT).not.toContain('sm:text-');
  });

  it('ThreadView dismiss is a 44px chevron', () => {
    const view = source('../ThreadView.tsx');
    expect(view).toContain('aria-label="Close thread"');
    expect(view).toContain('<IconChevronLeft size={ICON_SIZE.control} />');
  });

  it('group photo errors are plain words; rename has Save / Cancel and never saves on blur', () => {
    for (const line of [
      GROUP_PHOTO_UNAVAILABLE,
      GROUP_PHOTO_UNREADABLE,
      GROUP_PHOTO_UPLOAD_FAILED,
    ]) {
      expect(line).toMatch(/\.$/);
      expect(line).not.toMatch(/—|configured|error/i);
    }
    const sheet = source('../GroupInfoSheet.tsx');
    expect(sheet).not.toContain('onBlur={() => void submitRename()}');
    expect(sheet).toContain('data-group-rename-actions');
    expect(sheet).not.toContain('return up.error.message;');
  });

  it('plain "Loading" lines are skeletons', () => {
    const out = renderToStaticMarkup(listSkeleton('Loading members'));
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('aria-label="Loading members"');
    expect(out).toContain('animate-pulse');
    expect(out).toContain('min-h-[44px]');
    expect(source('../MemberPicker.tsx')).not.toContain('>Loading members<');
    expect(source('../PostPicker.tsx')).not.toContain('>Loading briefs<');
    expect(source('../GroupInfoSheet.tsx')).not.toContain('>Loading members<');
  });
});

describe('X7 FB2: popover menus move with the arrow keys', () => {
  it('down, up, home and end wrap over the items', () => {
    expect(nextMenuIndex('ArrowDown', -1, 3)).toBe(0);
    expect(nextMenuIndex('ArrowDown', 2, 3)).toBe(0);
    expect(nextMenuIndex('ArrowUp', 0, 3)).toBe(2);
    expect(nextMenuIndex('Home', 2, 3)).toBe(0);
    expect(nextMenuIndex('End', 0, 3)).toBe(2);
    expect(nextMenuIndex('Tab', 0, 3)).toBeNull();
    expect(nextMenuIndex('ArrowDown', 0, 0)).toBeNull();
    expect(source('../ChannelList.tsx')).toContain('moveMenuFocus(ref.current, event.key)');
    expect(source('../MessageActionMenu.tsx')).toContain(
      'moveMenuFocus(containerRef.current, event.key)',
    );
  });
});

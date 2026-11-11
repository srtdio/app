import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({ default: {} }));

// Work-chat guards (8 Nov 2026): L1 everyone on the left with no bubbles, and
// L3 no quote-reply in the main chat. Source checks, so a regression shows at
// the line that brings it back.
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// MessageBubble.tsx holds the row pieces moved out of MessageThread.tsx.
const THREAD =
  read('../components/chat/MessageThread.tsx') + read('../components/chat/MessageBubble.tsx');
const CHAT_TYPE = read('../components/chat/chat-type.ts');

describe('L1: no bubble classes in chat rows', () => {
  it('no own or peer bubble fill, light, tail or right-aligned own row', () => {
    for (const banned of [
      'bg-bubble-own',
      'lit-bubble-own',
      'lit-bubble-other',
      'BUBBLE_TAIL',
      'OWN_BUBBLE_CONTENT',
      "mine ? 'flex-row-reverse'",
      "mine && 'items-end'",
    ]) {
      expect(THREAD, banned).not.toContain(banned);
    }
    expect(CHAT_TYPE).not.toContain('BUBBLE_TAIL');
  });

  it('every group head carries the photo and the name line (DMs, groups, notes alike)', () => {
    expect(THREAD).toContain('const showMeta = head;');
    expect(THREAD).toContain('const gutter = !head;');
  });

  it('rows keep the long-press guard (no iOS text selection or callout)', () => {
    expect(CHAT_TYPE).toContain("NO_TOUCH_SELECT = 'select-none [-webkit-touch-callout:none]'");
    expect(THREAD).toMatch(
      /const rowClass = cn\(\s*'group flex items-start',[\s\S]{0,120}?sized\(MESSAGE_PHOTO_GAP, layout\),\s*railRowClass\(rail, false\),\s*NO_TOUCH_SELECT,/,
    );
  });
});

describe('L3: no quote strip in the main composer', () => {
  /** The main chat's <Composer ...> element: from its key to the first self-close. */
  function mainComposer(): string {
    const at = THREAD.indexOf('key={channelKey}');
    expect(at).toBeGreaterThan(-1);
    return THREAD.slice(
      at,
      THREAD.indexOf('/>', THREAD.indexOf('composerShared(view === null)', at)),
    );
  }

  it('the main composer never takes a reply or its media', () => {
    const composer = mainComposer();
    expect(composer).not.toContain('reply: replyDraft');
    expect(composer).not.toContain('replyMedia');
    expect(composer).not.toContain('about: aboutPost');
  });

  it('a main-chat send is always top level', () => {
    expect(THREAD).toContain('const rooted = null;');
  });
});

// Thread polish 2 (11 Nov 2026, locked): the long-press sheet is one page. No
// "More actions" row or page for any message, Delete is the last entry, a
// divider only ever sits between two groups that show. Thread polish 1's
// replier order stays.
describe('Thread polish 2: one-page sheet; Thread polish 1: replier order', () => {
  it('the sheet has no More actions row, page or page state', () => {
    const menu = read('../components/chat/MessageActionMenu.tsx');
    for (const gone of [
      'more-actions',
      'data-menu-page',
      'setPage',
      'menuPages',
      'moreActionsFolded',
      'MORE_ACTIONS_MIN',
      'HeaderBar',
      'IconChevronRight',
    ]) {
      expect(menu, gone).not.toContain(gone);
    }
    // The label lives on only as the replies bar's three-dot key's name.
    expect(menu.split('MORE_ACTIONS_LABEL').length - 1).toBe(1);
    expect(read('../components/chat/ThreadRail.tsx')).toContain('label={MORE_ACTIONS_LABEL}');
    // One list, drawn from menuEntries, on phone and laptop alike.
    expect(menu).toContain('const rest = menuEntries(items).slice(tiles.length);');
  });

  it('Delete is always last; a divider is never first, last or doubled (every mix)', async () => {
    const { MENU_DIVIDER, menuEntries, messageMenuItems } =
      await import('@/components/chat/MessageActionMenu');
    const flags = [
      'canReply',
      'canForward',
      'canAddToTasks',
      'canMarkUnread',
      'canEdit',
      'canCopyLink',
      'canCopy',
      'canSelectText',
      'canSaveToNotes',
      'canReplyPrivately',
      'canTranscribe',
      'canRemoveFile',
      'canDelete',
    ] as const;
    const broken: number[] = [];
    for (let mask = 0; mask < 1 << flags.length; mask += 1) {
      const on = (flag: (typeof flags)[number]): boolean =>
        (mask & (1 << flags.indexOf(flag))) !== 0;
      const entries = menuEntries(
        messageMenuItems({
          onReply: () => {},
          onCopy: () => {},
          canReply: on('canReply'),
          canForward: on('canForward'),
          canAddToTasks: on('canAddToTasks'),
          canMarkUnread: on('canMarkUnread'),
          canEdit: on('canEdit'),
          canCopyLink: on('canCopyLink'),
          canCopy: on('canCopy'),
          canSelectText: on('canSelectText'),
          canSaveToNotes: on('canSaveToNotes'),
          canReplyPrivately: on('canReplyPrivately'),
          canTranscribe: on('canTranscribe'),
          canRemoveFile: on('canRemoveFile'),
          canDelete: on('canDelete'),
        }),
      );
      const last = entries[entries.length - 1];
      const dividerOut =
        entries[0] === MENU_DIVIDER ||
        last === MENU_DIVIDER ||
        entries.some((e, i) => e === MENU_DIVIDER && entries[i + 1] === MENU_DIVIDER);
      const deleteOut =
        on('canDelete') && (last === undefined || last === MENU_DIVIDER || last.key !== 'delete');
      if (dividerOut || deleteOut) broken.push(mask);
    }
    expect(broken).toEqual([]);
  });

  it("a thread's main message always carries the add-reaction key; nothing else gains one", () => {
    expect(THREAD).toContain(
      'const rootAddKey = rootPlace && canReactChips && message.deleted !== true;',
    );
    expect(THREAD).toContain('{hasReactions || rootAddKey ? (');
    expect(THREAD).toContain('addWhenEmpty={rootAddKey}');
    expect(THREAD.split('addWhenEmpty').length - 1).toBe(1);
    // Opt-in only: the row still draws nothing with no reactions by default.
    expect(read('../components/ui/ReactionChips.tsx')).toContain(
      'if (reactions.length === 0 && !(props.addWhenEmpty === true && canReact)) return null;',
    );
  });

  it('replies row photos: the latest replier is last (chat and comments)', async () => {
    const { repliesInfoByRoot } = await import('@/lib/chat/thread-signals');
    const { latestRepliers } = await import('@/components/comments/Comments');
    const reply = (id: string, sender: string, time: number) =>
      ({
        id,
        senderUserId: sender,
        threadRootId: 'root',
        time,
        body: '',
        mine: false,
        state: 'sent',
      }) as unknown as Parameters<typeof repliesInfoByRoot>[0][number];
    const info = repliesInfoByRoot([
      reply('r1', 'ana', 1),
      reply('r2', 'bo', 2),
      reply('r3', 'cy', 3),
    ]).get('root');
    expect(info?.repliers).toEqual(['ana', 'bo', 'cy']);
    expect(latestRepliers([{ author_user_id: 'ana' }, { author_user_id: 'bo' }])).toEqual([
      'ana',
      'bo',
    ]);
  });
});

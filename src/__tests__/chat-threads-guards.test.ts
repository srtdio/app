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
      /const rowClass = cn\(\s*'group flex items-start gap-2',\s*railRowClass\(rail, false\),\s*NO_TOUCH_SELECT,/,
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

// Thread polish 1 (11 Nov 2026): the long-press sheet never hides two or fewer
// actions behind "More actions"; replies row photos end with the latest replier.
describe('Thread polish 1: More actions and replier order', () => {
  const item = (key: string, group: 'row' | 'more', danger = false) => ({
    kind: 'action' as const,
    key,
    label: key,
    icon: null,
    run: () => {},
    group,
    ...(danger ? { danger: true } : {}),
  });

  it('two or fewer hidden actions show as rows, danger last; three or more keep the page', async () => {
    const { menuPages, MORE_ACTIONS_MIN } = await import('@/components/chat/MessageActionMenu');
    expect(MORE_ACTIONS_MIN).toBe(3);
    const two = menuPages([
      item('copy', 'row'),
      item('edit', 'more'),
      item('delete', 'more', true),
    ]);
    expect(two.more).toEqual([]);
    expect(two.rows.map((i) => i.key)).toEqual(['copy', 'edit', 'delete']);
    const one = menuPages([item('copy', 'row'), item('delete', 'more', true)]);
    expect(one.more).toEqual([]);
    const three = menuPages([
      item('copy', 'row'),
      item('select-text', 'more'),
      item('edit', 'more'),
      item('delete', 'more', true),
    ]);
    expect(three.more.map((i) => i.key)).toEqual(['select-text', 'edit', 'delete']);
    expect(three.rows.map((i) => i.key)).toEqual(['copy']);
  });

  it('the renderer draws "More actions" only from menuPages', () => {
    const menu = read('../components/chat/MessageActionMenu.tsx');
    expect(menu).toContain('const { rows, more } = menuPages(items);');
    expect(menu).toMatch(/const moreRow =\s*more\.length > 0 \?/);
    expect(menu).not.toContain("itemsOfGroup(items, 'more');\n  const divider");
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

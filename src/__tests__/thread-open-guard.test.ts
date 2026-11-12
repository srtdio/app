import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  THREAD_FILL_MAX,
  THREAD_FILL_UNKNOWN,
  threadFillCount,
} from '@/components/chat/ThreadView';

// CLAUDE.md "Thread view", bottom anchor (12 Nov 2026): the thread view's
// content sits on the reply box, a thread opens with the keyboard down on
// touch (only an explicit Reply focuses the box), a laptop keeps the cursor in
// the box, and placeholders hold the bottom edge. This guard fails when a
// non-Reply open path passes focus true on touch, or when the thread view's
// scroller loses its bottom anchor.

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

const chat = read('../components/chat/MessageThread.tsx');
// Post / brief comments plus their thread layer (lifted, shared with Plan comment threads).
const comments =
  read('../components/comments/Comments.tsx') +
  read('../components/comments/CommentThreadLayer.tsx');

/** The arguments of every `name(` call in src, split at top-level commas. */
function callArgs(src: string, name: string): string[][] {
  const out: string[][] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(`${name}(`, from);
    if (at < 0) return out;
    from = at + name.length + 1;
    // A longer identifier ending in the name (reopenThread) is another function.
    if (/[\w$]/.test(src[at - 1] ?? '')) continue;
    const args: string[] = [];
    let depth = 0;
    let current = '';
    for (let i = from; i < src.length; i += 1) {
      const ch = src[i] ?? '';
      if (ch === ')' && depth === 0) break;
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
      if (ch === ',' && depth === 0) {
        args.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim() !== '') args.push(current.trim());
    out.push(args);
  }
}

describe('chat thread: focus on open', () => {
  const calls = [...callArgs(chat, 'openThread'), ...callArgs(chat, 'openThreadRef.current')];

  it('every open path is found', () => {
    // Chip, Reply, tap, replies row, jump, Talk about, Threads sheet.
    expect(calls.length).toBeGreaterThanOrEqual(7);
  });

  it('only the explicit Reply passes focus true; every other path is false or laptop only', () => {
    const focus = calls.map((args) => args[1]);
    const allowed = new Set<string | undefined>([undefined, 'false', 'finePointer', 'true']);
    expect(focus.filter((f) => !allowed.has(f))).toEqual([]);
    expect(focus.filter((f) => f === 'true')).toHaveLength(1);
    expect(chat).toMatch(
      /const handleReply = \(message: ThreadMessage\): void => \{\s*openThreadRef\.current\(threadRootOf\(message\), true, true\);\s*\};/,
    );
  });

  it('a plain tap is its own path: never the Reply path', () => {
    expect(chat).toMatch(
      /const handleTapOpen = \(message: ThreadMessage\): void => \{\s*openThreadRef\.current\(threadRootOf\(message\), finePointer, true\);\s*\};/,
    );
    expect(chat).toContain('onReply={handleReply}');
    expect(chat).toContain('onOpenThread={handleTapOpen}');
    expect(chat).toContain(': () => latest.current.onTapOpenThread(latest.current.message)');
    expect(chat).toContain(
      'const onTapOpenThread = useStableCallback(props.onOpenThread ?? props.onReply);',
    );
    // Swipe right and the sheet's Reply tile stay on the Reply path.
    expect(chat).toContain('onReply: () => latest.current.onSwipeReply(latest.current.message),');
    expect(chat).toContain('if (menu) props.onReply(menu.message);');
  });

  it('the replies row, Talk about and the Threads sheet focus on a laptop only', () => {
    expect(chat).toContain('onOpen: () => openThread(message.id, finePointer, true),');
    expect(chat).toContain('openThread(aboutDraft.cardMessageId, finePointer);');
    expect(chat).toContain('openThread(rootId, finePointer, true);');
    expect(chat).toContain('openThread(threadRootOf(jumpTarget));');
  });

  it('the thread composer: laptop focus on mount, Reply focus only when asked', () => {
    expect(chat).toMatch(/focusOnMount=\{finePointer\}\s*focusForReply=\{viewFocus\}/);
    expect(chat).toContain('setViewFocus(focus);');
  });
});

describe('chat thread: opens at the first message (13 Nov 2026, Slack)', () => {
  it('only the thread view passes openAtTop', () => {
    expect(chat.match(/^\s*openAtTop$/gm)).toHaveLength(1);
    expect(chat).toMatch(/loadOlderRow\s+openAtTop\s+\/>/);
    expect(chat).not.toContain('anchorBottom');
  });

  it('with it the list is top aligned and never sticks to the end on open', () => {
    expect(chat).toContain('            props.openAtTop === true,');
    expect(chat).toContain("className={topAligned ? undefined : 'mt-auto'}");
    expect(chat).toContain("{...(props.openAtTop === true ? { 'data-thread-open-top': '' } : {})}");
    expect(chat).toContain(
      'const stickRef = useRef(props.openAtTop === true ? false : openingIntent());',
    );
  });

  it('the down arrow shows only while rows are below the fold', () => {
    expect(chat).toContain('? list !== null && bottomDistance(list) > 1');
    expect(chat).toContain('props.openAtTop === true ? bottomDistance(el) > 1 : !stickRef.current');
  });

  it('the shared scroller class is unchanged (the main chat renders the same)', () => {
    expect(chat).toContain("'flex flex-1 flex-col overflow-y-auto overflow-x-hidden py-2',");
  });
});

describe('comment thread: focus on open and bottom anchor', () => {
  const calls = callArgs(comments, 'openThread');

  it('only swipe right (the explicit Reply) passes focus true', () => {
    const focus = calls.map((args) => args[1]);
    expect(calls.length).toBeGreaterThanOrEqual(5);
    const allowed = new Set<string | undefined>(['false', '!coarsePointer', 'true']);
    expect(focus.filter((f) => !allowed.has(f))).toEqual([]);
    expect(focus.filter((f) => f === 'true')).toHaveLength(1);
    expect(comments).toContain(
      'onReply: canOpen ? () => openThread(message.id, true) : undefined,',
    );
    expect(comments).toContain(
      'onOpen: canOpen ? () => openThread(message.id, !coarsePointer) : undefined,',
    );
    expect(comments).toContain('onReply={wiring.onReply ?? wiring.onOpen}');
    expect(comments).toContain('onTapOpen={wiring.onOpen}');
  });

  it('the thread composer: laptop focus on mount, Reply focus only when asked', () => {
    expect(comments).toMatch(/focusOnMount=\{!coarsePointer\}\s*focusForReply=\{thread\.focus\}/);
  });

  it('the scroller opens at the first message, its list top aligned, the arrow over it', () => {
    expect(comments).toContain(
      'className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"',
    );
    expect(comments).toContain('<ul className="flex shrink-0 flex-col pb-3 pt-4">');
    expect(comments).not.toContain('mt-auto');
    expect(comments).toContain('data-thread-open-top=""');
    expect(comments).toContain('if (!landing) scrollRef.current?.scrollTo({ top: 0 });');
    expect(comments).toContain('<LatestButton');
  });

  it("a thread's rows say their day, as chat's threads do", () => {
    expect(comments).toContain("timeLabel={place.threadPlace !== undefined ? 'day' : undefined}");
    expect(read('../components/chat/ThreadCommentRow.tsx')).toContain(
      'timeLabel={props.timeLabel}',
    );
  });
});

describe('placeholders hold the bottom edge', () => {
  it('the known replies still to land, at most 6; 3 when unknown', () => {
    expect(THREAD_FILL_UNKNOWN).toBe(3);
    expect(THREAD_FILL_MAX).toBe(6);
    expect(threadFillCount(null)).toBe(3);
    expect(threadFillCount(undefined)).toBe(3);
    expect(threadFillCount(0)).toBe(0);
    expect(threadFillCount(1)).toBe(1);
    expect(threadFillCount(4)).toBe(4);
    expect(threadFillCount(40)).toBe(6);
    expect(threadFillCount(-2)).toBe(0);
  });

  it('the chat thread passes the replies still to land', () => {
    expect(chat).toContain('viewCount - viewParts.replies.length');
  });
});

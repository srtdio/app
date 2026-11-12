import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BUBBLE_BODY_TYPE,
  COMPOSER_INPUT_TYPE,
  DATE_LINE_TYPE,
  MESSAGE_AVATAR_ROLE,
  MESSAGE_PHOTO_BOX,
  MESSAGE_PHOTO_COL,
  MESSAGE_PHOTO_GAP,
  REPLIES_ROW_PAD,
  SEEN_LINE_PAD,
  SENDER_NAME_TYPE,
} from '@/components/chat/chat-type';
import { AVATAR_PX } from '@/components/ui/Avatar';

// Message family guard (CLAUDE.md "Work chat", 11 Nov 2026). Every surface
// that draws message rows is one family: photo 36 + 12 to the text on touch
// (32 + 8 laptop), name 17 bold and text 17 / 20 on touch, the date line in
// place of the old centred pill, loading placeholders on the rows' own photo
// box, and the composer typing in the message text's token. Source is read
// as text; nothing renders.

const SRC = fileURLToPath(new URL('../', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string): string => readFileSync(`${SRC}${rel}`, 'utf8');

const BUBBLE = read('components/chat/MessageBubble.tsx');
const CHAT_TYPE = read('components/chat/chat-type.ts');

/** Tailwind's 4px grid: step N is 4N px. */
const stepPx = (cls: string, prefix: string): number => {
  const m = new RegExp(`(?:^|\\s)${prefix}-(\\d+)(?:\\s|$)`).exec(cls);
  return m === null ? Number.NaN : Number(m[1]) * 4;
};

/** The size token of a type class string ("!text-msg font-normal" -> "msg"). */
const sizeToken = (cls: string): string => /(?:^|\s)!?text-([\w-]+)/.exec(cls)?.[1] ?? '';

/** The surfaces that draw a message photo placeholder (a Bone). */
const PLACEHOLDER_FILES = [
  'components/chat/ListSkeleton.tsx',
  'components/chat/ThreadView.tsx',
  'components/comments/Comments.tsx',
  'components/catch-up/CatchUpRows.tsx',
] as const;

/** The surfaces that draw a message row's photo column. */
const ROW_FILES = [
  'components/chat/MessageBubble.tsx',
  'components/chat/ThreadRail.tsx',
  'components/catch-up/CatchUpRows.tsx',
] as const;

describe('message family: the date line replaces the pill', () => {
  /** DateLine's own source: from its declaration to the next top-level declaration. */
  const dateLine = (): string => {
    const at = BUBBLE.indexOf('export function DateLine(');
    expect(at, 'DateLine is declared in MessageBubble.tsx').toBeGreaterThan(-1);
    const end = BUBBLE.indexOf('\n}\n', at);
    return BUBBLE.slice(at, end);
  };

  it('the pill classes never return', () => {
    const src = dateLine();
    for (const gone of [
      'rounded-full',
      'border-border-strong',
      'lit-pill',
      'bg-panel',
      'justify-center',
      'self-center',
      'font-mono',
      'uppercase',
    ]) {
      expect(src, `the date line carries ${gone}`).not.toContain(gone);
    }
    expect(CHAT_TYPE).not.toContain('DATE_PILL_TYPE');
    expect(BUBBLE).not.toContain('DATE_PILL_TYPE');
    expect(BUBBLE).not.toMatch(/\bDayPill\b/);
  });

  it('one shared part: every message surface draws DateLine, never its own', () => {
    for (const rel of [
      'components/chat/MessageThread.tsx',
      'components/chat/PlanItemThread.tsx',
      'components/comments/Comments.tsx',
      'components/catch-up/CatchUpRows.tsx',
    ]) {
      const src = read(rel);
      expect(src, rel).toMatch(/<DateLine\b/);
      expect(src, rel).not.toMatch(/\bDayPill\b/);
    }
  });

  it('look: bold fg words on the 16 pad over a full-width border hairline; separator kept', () => {
    const src = dateLine();
    expect(src).toContain('role="separator"');
    expect(src).toContain('aria-label={label}');
    expect(src).toContain('data-date-line=""');
    // 16 above (0 as the first row), 8 to the hairline, 12 to the next row.
    expect(src).toContain('className="flex flex-col pb-3 pt-4 first:pt-0"');
    expect(src).toContain('className="block border-b border-border px-4 pb-2"');
    expect(src).toContain("cn('block truncate text-fg', sized(DATE_LINE_TYPE, layout))");
    // 17 bold touch, 15 bold laptop.
    expect(DATE_LINE_TYPE).toEqual({ touch: 'text-xl font-bold', laptop: 'text-lg font-bold' });
  });
});

describe('message family: photo 36 + 12 on touch, 32 + 8 on laptop', () => {
  it('the family sizes', () => {
    expect(AVATAR_PX[MESSAGE_AVATAR_ROLE.touch]).toBe(36);
    expect(AVATAR_PX[MESSAGE_AVATAR_ROLE.laptop]).toBe(32);
    expect(stepPx(MESSAGE_PHOTO_BOX.touch, 'w')).toBe(36);
    expect(stepPx(MESSAGE_PHOTO_BOX.touch, 'h')).toBe(36);
    expect(stepPx(MESSAGE_PHOTO_BOX.laptop, 'w')).toBe(32);
    expect(stepPx(MESSAGE_PHOTO_BOX.laptop, 'h')).toBe(32);
    expect(stepPx(MESSAGE_PHOTO_COL.touch, 'w')).toBe(36);
    expect(stepPx(MESSAGE_PHOTO_COL.laptop, 'w')).toBe(32);
    expect(stepPx(MESSAGE_PHOTO_GAP.touch, 'gap')).toBe(12);
    expect(stepPx(MESSAGE_PHOTO_GAP.laptop, 'gap')).toBe(8);
  });

  it('the replies row lands on the text column: 16 + photo + gap', () => {
    for (const layout of ['touch', 'laptop'] as const) {
      const column =
        16 + AVATAR_PX[MESSAGE_AVATAR_ROLE[layout]] + stepPx(MESSAGE_PHOTO_GAP[layout], 'gap');
      // The row's left pad plus its button's 8 inner pad.
      expect(stepPx(REPLIES_ROW_PAD[layout], 'pl') + 8, layout).toBe(column);
    }
    expect(16 + 36 + 12).toBe(64);
  });

  it('a message row takes its photo, spacer and gap from the family, never a literal', () => {
    expect(BUBBLE).toMatch(
      /const rowClass = cn\(\s*'group flex items-start',[\s\S]{0,120}?sized\(MESSAGE_PHOTO_GAP, layout\),/,
    );
    expect(BUBBLE).toContain('role={MESSAGE_AVATAR_ROLE[layout]}');
    expect(BUBBLE.split('sized(MESSAGE_PHOTO_COL, layout)').length - 1).toBe(2);
    expect(BUBBLE).not.toContain("'group flex items-start gap-2'");
    for (const rel of ROW_FILES) {
      const src = read(rel);
      expect(src, `${rel}: a literal 32 photo column`).not.toMatch(/["'\s]w-8 shrink-0/);
    }
  });

  it('name 17 bold and text 17 / 20 on touch; laptop as before', () => {
    expect(SENDER_NAME_TYPE).toEqual({
      touch: 'text-xl font-bold',
      laptop: 'text-md font-semibold',
    });
    expect(BUBBLE_BODY_TYPE).toEqual({
      touch: 'text-msg font-normal',
      laptop: 'text-base font-normal',
    });
    expect(BUBBLE.split('sized(SENDER_NAME_TYPE, layout)').length - 1).toBe(2);
    // The named token: 17 on a 20 line, known to cn's font-size group.
    const tailwind = readFileSync(`${ROOT}tailwind.config.ts`, 'utf8');
    expect(tailwind).toMatch(/msg: \['17px', '20px'\]/);
    expect(read('lib/cn.ts')).toMatch(/text: \[[^\]]*'msg'[^\]]*\]/);
  });
});

describe('message family: a row lands where its placeholder was', () => {
  it("every placeholder's photo box is the rows' own box, per layout", () => {
    for (const rel of PLACEHOLDER_FILES) {
      const src = read(rel);
      expect(src, `${rel}: the bone takes the family photo box`).toMatch(
        /<Bone\b[^>]*sized\(MESSAGE_PHOTO_BOX, layout\)/,
      );
      expect(src, `${rel}: a literal photo box`).not.toMatch(/\bh-8 w-8\b/);
      expect(src, `${rel}: a literal photo box`).not.toMatch(/\bh-9 w-9\b/);
    }
  });

  it('a placeholder keeps the gap of the row that replaces it', () => {
    // Main-chat family rows (Comments' main list, the list skeleton): the family gap.
    for (const rel of ['components/chat/ListSkeleton.tsx', 'components/comments/Comments.tsx']) {
      expect(read(rel), rel).toContain('sized(MESSAGE_PHOTO_GAP, layout)');
    }
    // Thread replies and Catch up rows sit 12 from the photo on both layouts;
    // their placeholders keep that 12.
    expect(BUBBLE).toContain("replyPlace && 'gap-3'");
    expect(read('components/chat/ThreadView.tsx')).toMatch(
      /<li key=\{at\} data-thread-fill-row="" className="flex gap-3" aria-hidden="true">/,
    );
    const catchUp = read('components/catch-up/CatchUpRows.tsx');
    expect(catchUp).toContain("cn('relative flex gap-3 py-2', CATCH_UP_ROW_X)");
    expect(catchUp).toContain("cn('flex gap-3 py-2', CATCH_UP_ROW_X)");
  });
});

describe('message family: typed text and sent text share one token', () => {
  it('the composer and the message text use the same size token on touch', () => {
    expect(sizeToken(COMPOSER_INPUT_TYPE.touch)).toBe('msg');
    expect(sizeToken(COMPOSER_INPUT_TYPE.touch)).toBe(sizeToken(BUBBLE_BODY_TYPE.touch));
    // Important, so it wins over the compact Textarea's inline default.
    expect(COMPOSER_INPUT_TYPE.touch.startsWith('!text-')).toBe(true);
    expect(COMPOSER_INPUT_TYPE.laptop).toBe('!text-lg font-normal');
  });
});

describe('message family: Catch up, Seen / Read by and the phone thread root (12 Nov 2026)', () => {
  it('a Catch up row names and writes in the family tokens', () => {
    const rows = read('components/catch-up/CatchUpRows.tsx');
    expect(rows, 'the name takes the family name token').toContain(
      'sized(SENDER_NAME_TYPE, layout)',
    );
    // RichText (comments, messages) and the event line both take the body token.
    expect(
      rows.split('sized(BUBBLE_BODY_TYPE, layout)').length - 1,
      'every row text takes the family body token',
    ).toBeGreaterThanOrEqual(2);
    // The open-thread key never adds height to a one-line row: its 44 is a hit area.
    const hit = /export const OPEN_THREAD_HIT =\s*"([^"]*)"/.exec(rows)?.[1] ?? '';
    expect(hit.split(' '), 'the text key has no 44 box of its own').toContain('min-h-0');
    expect(hit, 'the 44 tap is a hit area').toContain('before:h-11');
    expect(rows).toMatch(/data-catch-up-open-thread=""[\s\S]{0,400}OPEN_THREAD_HIT/);
  });

  it('Seen and Read by start on the text column: 64 touch, 56 laptop, tokens only', () => {
    const layer = read('components/chat/ReadingLayer.tsx');
    expect(layer, 'no raw left pad in ReadingLayer').not.toMatch(/\bpl-\d/);
    expect(layer).toContain('sized(SEEN_LINE_PAD, layout)');
    expect(layer).toContain('sized(REPLIES_ROW_PAD, layout)');
    expect(stepPx(SEEN_LINE_PAD.touch, 'pl')).toBe(64);
    expect(stepPx(SEEN_LINE_PAD.laptop, 'pl')).toBe(56);
    // Read by's button pads 8 inside: 56 + 8 touch, 48 + 8 laptop.
    expect(stepPx(REPLIES_ROW_PAD.touch, 'pl') + 8).toBe(64);
    expect(stepPx(REPLIES_ROW_PAD.laptop, 'pl') + 8).toBe(56);
  });

  it("the thread's main message stacks on laptop only; on phone it is a head row", () => {
    expect(BUBBLE).toContain("const rootStack = rootPlace && layout === 'laptop';");
    // Every stacked-geometry branch reads rootStack, never rootPlace.
    expect(BUBBLE).toContain("rootStack ? 'relative flex-col items-stretch gap-2' : 'flex-row'");
    expect(BUBBLE).toContain('const senderLine = rootStack ? null : showMeta ?');
    expect(BUBBLE).toContain('const photo = rootStack ? (');
    expect(BUBBLE).not.toMatch(/rootPlace && 'absolute/);
    expect(BUBBLE).not.toMatch(/rootPlace \? 'relative flex-col/);
  });
});

describe('message family: phone edges and columns (12 Nov 2026)', () => {
  const THREAD = read('components/chat/MessageThread.tsx');

  it('the conversation bar: back ink on 16, the photo on the 64 column; laptop untouched', () => {
    // 16 gutter - 12 pull = the 44 box at 4, its 20 glyph box at 16 (the pull
    // slides the ink onto 16); 4 + 44 + 4 + the bar's 12 gap = 64.
    expect(THREAD).toContain(
      "return layout === 'touch' && !selecting ? 'px-4' : sized(HEADER_PAD, layout);",
    );
    expect(THREAD).toMatch(/layout === 'touch' \? `\$\{LEADING_PULL\} mr-1` : undefined;/);
    expect(THREAD.match(/className=\{threadBackKey\(layout\)\}/g)?.length).toBe(2);
  });

  it('a long name gives way on a phone; the time beside it is never cut', () => {
    expect(BUBBLE).toContain(
      "'block min-w-0 max-w-full truncate max-md:flex max-md:items-baseline'",
    );
    expect(BUBBLE).toContain("export const SENDER_NAME_GIVES = 'max-md:min-w-0 max-md:truncate';");
    expect(BUBBLE).toMatch(
      /data-sender-time=""\s+className=\{cn\('ml-2 text-fg-3 max-md:shrink-0'/,
    );
  });

  it('the chat tip starts on 16 and wraps on a phone; "Got it" keeps its 44 box', () => {
    const tip = read('components/chat/ThreadHoldTip.tsx');
    expect(tip).toContain("layout === 'laptop' ? 'pl-3' : 'pl-1'");
    expect(tip).toContain("cn('min-w-0 flex-1', layout === 'laptop' && 'truncate')");
    // Phone: the strip and words on 16 (PHONE_PAD_FLUSH), "Got it"'s words on the right edge.
    expect(tip).toContain('PHONE_PAD_FLUSH');
    expect(tip).toContain("className={cn('min-w-11 shrink-0', TEXT_KEY_PULL)}");
  });

  it('thread strip and root head: "Reply in thread" and the root name start on 64', () => {
    const rail = read('components/chat/ThreadRail.tsx');
    // 16 + the 36 icon column + 12.
    expect(rail).toContain("chat: { x: 'px-4', gap: 'gap-2 max-md:gap-3' }");
    // 16 + the 40 root photo + 8.
    expect(rail).toContain('className="flex min-w-0 items-center gap-3 max-md:gap-2"');
    // The strip's last key: its ink ends on the 16 edge.
    expect(rail).toContain("cn('flex shrink-0 items-center', TRAILING_PULL, INK_TRAILING_LAST)");
  });
});

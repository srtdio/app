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

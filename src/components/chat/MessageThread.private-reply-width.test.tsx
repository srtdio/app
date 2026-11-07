// @vitest-environment jsdom
// Reply privately bubble width. An own bubble is fit-content in an items-end
// column, so the quote's one truncated line (nowrap) put its whole text width
// into the bubble's min-content and the bubble ran past BUBBLE_MAX off the
// left edge. The fix is one class in bubbleClass (max-w-full: every bubble is
// capped at its column, whose width is BUBBLE_MAX); album and voice keep their
// min widths. Geometry at 390px and 1280px is proved in e2e/visual
// (chat-dm-private-reply-long); jsdom has no layout, so this pins the chain.

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { bubbleClass } from '@/components/chat/MessageThread';
import { ReplyQuoteBox } from '@/components/chat/ReplyQuote';
import { PrivateReplyBar } from '@/components/chat/Composer';
import { BUBBLE_MAX } from '@/components/chat/chat-type';

const EXCERPT = 'Love the new cover shot, ship it today. '.repeat(5).slice(0, 200);
const WHERE = 'Monday carousel for the spring launch across all three market'.slice(0, 60);

const tokens = (cls: string): string[] => cls.split(/\s+/).filter(Boolean);

describe('Reply privately bubble width', () => {
  it('BUBBLE_MAX is unchanged: 76% touch, 65% laptop', () => {
    expect(BUBBLE_MAX).toEqual({ touch: 'max-w-[76%]', laptop: 'max-w-[65%]' });
  });

  for (const layout of ['touch', 'laptop'] as const) {
    for (const mine of [true, false]) {
      it(`${layout} ${mine ? 'mine' : 'theirs'}: the bubble caps at its column`, () => {
        const cls = tokens(
          bubbleClass({
            mine,
            head: true,
            tail: true,
            layout,
            failed: false,
            voiceOnly: false,
          }),
        );
        expect(cls).toEqual(expect.arrayContaining(['min-w-0', 'max-w-full']));
      });
    }

    it(`${layout}: album and voice keep their min widths beside the cap`, () => {
      const shape = { mine: true, head: true, tail: true, layout, failed: false };
      expect(tokens(bubbleClass({ ...shape, voiceOnly: false, album: true }))).toEqual(
        expect.arrayContaining(['max-w-full', 'min-w-60']),
      );
      expect(tokens(bubbleClass({ ...shape, voiceOnly: true }))).toEqual(
        expect.arrayContaining(['max-w-full', 'min-w-56']),
      );
    });

    it(`${layout}: the long quote cuts header and preview on one line each`, () => {
      document.body.innerHTML = renderToStaticMarkup(
        <ReplyQuoteBox
          author={`Priya Shah · ${WHERE}`}
          preview={EXCERPT}
          inBubble={layout}
          oneLine
          onJump={() => {}}
        />,
      );
      const box = document.body.firstElementChild as HTMLElement;
      expect(tokens(box.className)).toEqual(expect.arrayContaining(['min-w-0', 'overflow-hidden']));
      const header = [...document.querySelectorAll('span')].find(
        (s) => s.children.length === 0 && (s.textContent ?? '').startsWith('Priya Shah'),
      );
      expect(header !== undefined && tokens(header.className)).toEqual(
        expect.arrayContaining(['line-clamp-1']),
      );
      const preview = [...document.querySelectorAll('span')].find(
        (s) => s.textContent === EXCERPT && s.children.length === 0,
      );
      expect(preview !== undefined && tokens(preview.className)).toEqual(
        expect.arrayContaining(['truncate']),
      );
    });
  }
});

describe('Composer Reply privately strip width', () => {
  it('never wider than the composer: the strip shrinks and both lines cut', () => {
    document.body.innerHTML = renderToStaticMarkup(
      <PrivateReplyBar
        quote={{ authorName: 'Priya Shah', whereLabel: WHERE }}
        preview={EXCERPT}
        onRemove={() => {}}
      />,
    );
    const bar = document.querySelector<HTMLElement>('[data-private-reply-bar]');
    expect(bar).not.toBeNull();
    expect(tokens(bar?.className ?? '')).toEqual(expect.arrayContaining(['min-w-0', 'max-w-full']));
    const html = document.body.innerHTML;
    expect(html).toContain('line-clamp-1');
    expect(html).toContain('truncate');
  });
});

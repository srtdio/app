import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { CommentEmojiButton, insertIntoTextarea } from '@/components/comments/CommentEmojiButton';
import type { CaretTextarea } from '@/components/comments/CommentEmojiButton';
import { LAPTOP_LAYOUT_QUERY } from '@/components/chat/chat-type';

function stubLayout(laptop: boolean): void {
  vi.stubGlobal('window', {
    matchMedia: (query: string) => ({
      matches: laptop && query === LAPTOP_LAYOUT_QUERY,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CommentEmojiButton: laptop only', () => {
  it('renders a 44x44 Emoji dialog button when the laptop query matches', () => {
    stubLayout(true);
    const html = renderToStaticMarkup(<CommentEmojiButton onPick={() => {}} />);
    expect(html).toContain('aria-label="Emoji"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('h-11 w-11');
    // Closed: no picker in the markup.
    expect(html).not.toContain('Emoji picker');
  });

  it('renders nothing on touch', () => {
    stubLayout(false);
    expect(renderToStaticMarkup(<CommentEmojiButton onPick={() => {}} />)).toBe('');
  });
});

function fakeTextarea(start: number, end = start) {
  const area: CaretTextarea & { caret: [number, number] | null; focused: boolean } = {
    selectionStart: start,
    selectionEnd: end,
    caret: null,
    focused: false,
    focus: () => {
      area.focused = true;
    },
    setSelectionRange: (a: number, b: number) => {
      area.caret = [a, b];
    },
  };
  return area;
}

describe('insertIntoTextarea (Slot, Pin, Caption composers)', () => {
  function run(area: CaretTextarea | null, value: string, char: string): string {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    let out = value;
    insertIntoTextarea(
      () => area,
      value,
      char,
      (next) => {
        out = next;
      },
    );
    return out;
  }

  it('inserts at the caret mid-text, not at the end, and puts the caret after it', () => {
    const area = fakeTextarea(3);
    expect(run(area, 'abcdef', '😀')).toBe('abc😀def');
    expect(area.focused).toBe(true);
    expect(area.caret).toEqual([5, 5]);
  });

  it('replaces a selected range', () => {
    const area = fakeTextarea(1, 4);
    expect(run(area, 'abcdef', '🎉')).toBe('a🎉ef');
    expect(area.caret).toEqual([3, 3]);
  });

  it('two picks in a row insert both, in order', () => {
    const area = fakeTextarea(2);
    const first = run(area, 'hiya', '😀');
    area.selectionStart = area.selectionEnd = 4;
    expect(run(area, first, '🎉')).toBe('hi😀🎉ya');
  });

  it('with no textarea, appends at the end', () => {
    expect(run(null, 'abc', '😀')).toBe('abc😀');
  });
});

describe('every comment input wires the emoji button', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  it.each([
    'components/comments/CommentComposer.tsx',
    'components/comments/SlotComposer.tsx',
    'components/pages/pcs/PinAnnotationComposer.tsx',
    'components/pages/pcs/CaptionAnnotationComposer.tsx',
  ])('%s renders CommentEmojiButton', (file) => {
    expect(readFileSync(root + file, 'utf8')).toContain('<CommentEmojiButton');
  });

  it('the button never imports the picker body statically', () => {
    const source = readFileSync(root + 'components/comments/CommentEmojiButton.tsx', 'utf8');
    expect(source).not.toMatch(/from '@\/components\/chat\/EmojiPicker'/);
  });
});

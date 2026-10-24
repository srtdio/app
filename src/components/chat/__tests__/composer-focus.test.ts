import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { hashPickerQuery, shouldFocusComposer } from '@/components/chat/Composer';
import { chatLayout, COMPOSER_INPUT_TYPE, sized } from '@/components/chat/chat-type';
import { Textarea } from '@/components/ui/Textarea';

describe('composer focus on open', () => {
  const idle = { finePointer: true, editing: false, hashOpen: false, overlayOpen: false };

  it('focuses on a fine pointer (laptop) only', () => {
    expect(shouldFocusComposer(idle)).toBe(true);
    expect(shouldFocusComposer({ ...idle, finePointer: false })).toBe(false);
  });

  it('never steals focus from edit mode, the hash picker, or an open menu / sheet / lightbox', () => {
    expect(shouldFocusComposer({ ...idle, editing: true })).toBe(false);
    expect(shouldFocusComposer({ ...idle, hashOpen: true })).toBe(false);
    expect(shouldFocusComposer({ ...idle, overlayOpen: true })).toBe(false);
  });

  it('F9: a restored draft with an open hash token does not auto-focus', () => {
    // The trigger character is assembled so chat files stay free of the raw literal.
    const draft = `about ${String.fromCharCode(35)}12`;
    const hashOpen =
      hashPickerQuery({ enabled: true, dismissed: false, text: draft, caret: draft.length }) !==
      null;
    expect(hashOpen).toBe(true);
    expect(shouldFocusComposer({ ...idle, hashOpen })).toBe(false);
    const plain = 'about 12';
    const closed =
      hashPickerQuery({ enabled: true, dismissed: false, text: plain, caret: plain.length }) !==
      null;
    expect(shouldFocusComposer({ ...idle, hashOpen: closed })).toBe(true);
  });
});

describe('F7: composer input size by input, never under 16px on touch', () => {
  it('coarse pointer at 1024px (iPad) is 17px; fine pointer at 1280px is 15px', () => {
    const ipad = sized(COMPOSER_INPUT_TYPE, chatLayout({ finePointer: false, widthPx: 1024 }));
    expect(ipad).toContain('!text-[17px] !leading-[22px]');
    const laptop = sized(COMPOSER_INPUT_TYPE, chatLayout({ finePointer: true, widthPx: 1280 }));
    expect(laptop).toContain('!text-[15px] !leading-[20px]');
  });

  it('every touch width stays at 16px or more, with no width breakpoint', () => {
    for (const widthPx of [320, 390, 768, 1024, 1366]) {
      const cls = sized(COMPOSER_INPUT_TYPE, chatLayout({ finePointer: false, widthPx }));
      const px = Number(/!text-\[(\d+)px\]/.exec(cls)?.[1]);
      expect(px).toBeGreaterThanOrEqual(16);
      expect(cls).not.toContain('md:');
    }
  });
});

describe('composer textarea: no iOS AutoFill bar', () => {
  // One Composer serves both the main thread and the thread view (MessageThread
  // mounts it twice), so its single textarea covers both.
  const src = readFileSync(fileURLToPath(new URL('../Composer.tsx', import.meta.url)), 'utf8');
  const hints = ['email', 'name', 'address', 'password', 'card', 'phone', 'tel', 'username'];
  const composerTextarea = (): string => {
    const tags = src.match(/<Textarea\b[\s\S]*?\/>/g) ?? [];
    expect(tags).toHaveLength(1);
    return tags[0] ?? '';
  };

  it('sets autoComplete="off" and leaves spellcheck / autocorrect as today', () => {
    const tag = composerTextarea();
    expect(tag).toContain('autoComplete="off"');
    expect(tag).not.toMatch(/spellCheck|autoCorrect|autoCapitalize/);
  });

  it('the shared Textarea forwards autoComplete="off" to the DOM textarea', () => {
    const html = renderToStaticMarkup(
      createElement(Textarea, { autoComplete: 'off', rows: 1, compact: true }),
    );
    expect(html).toMatch(/<textarea[^>]*autoComplete="off"/);
  });

  it('no name / id / aria attribute carries an AutoFill hint word', () => {
    const attrs = [
      ...composerTextarea().matchAll(/\s(name|id|aria-[\w-]+)=\{?["'`]?([^"'`}\s]*)/g),
    ];
    for (const [, key, value] of attrs) {
      for (const hint of hints) expect(`${key}=${value}`.toLowerCase()).not.toContain(hint);
    }
  });
});

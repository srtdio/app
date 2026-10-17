import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { readFileSync } from 'node:fs';
import { DRAFT_CARD_DEBOUNCE_MS, draftCardUrlFor } from '@/components/chat/Composer';

const ORIGIN = 'https://srtd.io';

describe('composer draft link card', () => {
  it('waits 600 ms after typing before showing the card', () => {
    expect(DRAFT_CARD_DEBOUNCE_MS).toBe(600);
  });

  it('previews the first external link only', () => {
    expect(draftCardUrlFor('a https://x.com/1 b https://y.com/2', null, false, ORIGIN)).toBe(
      'https://x.com/1',
    );
    expect(draftCardUrlFor('no link', null, false, ORIGIN)).toBeNull();
  });

  it('X removes the card for this draft; the link text is untouched', () => {
    const text = 'see https://x.com/1';
    expect(draftCardUrlFor(text, 'https://x.com/1', false, ORIGIN)).toBeNull();
    // A different link typed later gets its own card.
    expect(draftCardUrlFor('see https://y.com/2', 'https://x.com/1', false, ORIGIN)).toBe(
      'https://y.com/2',
    );
    // After a send the dismissal resets (null): the next draft shows its card.
    expect(draftCardUrlFor(text, null, false, ORIGIN)).toBe('https://x.com/1');
  });

  it('no card while editing, and none for links to this app', () => {
    expect(draftCardUrlFor('https://x.com/1', null, true, ORIGIN)).toBeNull();
    expect(draftCardUrlFor('https://srtd.io/p/abc', null, false, ORIGIN)).toBeNull();
  });

  it('the X is not persisted: no field carries it (STEP 0), so the send path is unchanged', () => {
    const src = readFileSync('src/components/chat/Composer.tsx', 'utf8');
    expect(src).not.toMatch(/link_preview/);
  });
});

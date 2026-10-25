import { afterEach, describe, expect, it, vi } from 'vitest';

const { laptopNow } = vi.hoisted(() => ({ laptopNow: vi.fn(() => false) }));
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  isLaptopNow: laptopNow,
}));

import * as chatType from '@/components/chat/chat-type';
import {
  chatLayout,
  HOVER_POINTER_QUERY,
  LAPTOP_LAYOUT_QUERY,
  readChatLayout,
  type ChatSize,
} from '@/components/chat/chat-type';

describe('F12: the size table follows the width (the one breakpoint), never the pointer', () => {
  it('1024 (iPad landscape) -> laptop; 768 (iPad portrait) -> laptop; 390 -> touch; 767 -> touch', () => {
    expect(chatLayout({ widthPx: 1024 })).toBe('laptop');
    expect(chatLayout({ widthPx: 768 })).toBe('laptop');
    expect(chatLayout({ widthPx: 1280 })).toBe('laptop');
    expect(chatLayout({ widthPx: 390 })).toBe('touch');
    expect(chatLayout({ widthPx: 767 })).toBe('touch');
  });

  it('the laptop query is width only: 768px, no pointer clause', () => {
    expect(LAPTOP_LAYOUT_QUERY).toBe('(min-width: 768px)');
    expect(LAPTOP_LAYOUT_QUERY).not.toContain('pointer');
    expect(HOVER_POINTER_QUERY).toBe('(hover: hover) and (pointer: fine)');
  });

  it('every paired chat size has a touch and a laptop value and no width breakpoint', () => {
    const pairs = Object.values(chatType).filter(
      (value): value is ChatSize =>
        typeof value === 'object' && value !== null && 'touch' in value && 'laptop' in value,
    );
    expect(pairs.length).toBeGreaterThanOrEqual(12);
    for (const pair of pairs) {
      expect(pair.touch).not.toContain('md:');
      expect(pair.laptop).not.toContain('md:');
    }
  });
});

describe('F12: first paint resolves synchronously', () => {
  afterEach(() => {
    laptopNow.mockReset();
  });

  it('reads the width on the call, so the initializer already has the final table', () => {
    laptopNow.mockReturnValue(true);
    expect(readChatLayout()).toBe('laptop');
    laptopNow.mockReturnValue(false);
    expect(readChatLayout()).toBe('touch');
  });

  it('reads the one breakpoint helper, never a pointer query', () => {
    laptopNow.mockReturnValue(false);
    readChatLayout();
    expect(laptopNow).toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import {
  centreDelta,
  holdActive,
  recentreNeeded,
  rowInsideList,
} from '@/components/chat/jump-hold';

// The iPhone thread: the list sits below the header and review bar (top 92)
// and above the tip and composer (bottom 527).
const LIST = { top: 92, bottom: 527 };

describe('jump hold', () => {
  it('centreDelta moves the row middle onto the list middle', () => {
    expect(centreDelta(LIST, { top: 300, bottom: 340 })).toBe(10.5);
    expect(centreDelta(LIST, { top: 40, bottom: 80 })).toBe(-249.5);
  });

  it('a row under the header is not inside the list, though it is inside the window', () => {
    // The CI failure: the target sat at 40..80, on screen by window height but
    // hidden behind the header, so the old window check never snapped it in.
    expect(rowInsideList(LIST, { top: 40, bottom: 80 })).toBe(false);
    expect(rowInsideList(LIST, { top: 520, bottom: 560 })).toBe(false);
    expect(rowInsideList(LIST, { top: 280, bottom: 330 })).toBe(true);
  });

  it('a card above the row growing after the jump re-centres it', () => {
    const row = { top: 280, bottom: 330 };
    expect(recentreNeeded({ moved: 300, settle: false, list: LIST, row })).toBe(true);
    expect(recentreNeeded({ moved: -12, settle: false, list: LIST, row })).toBe(true);
  });

  it('a running smooth scroll is never cut: no move, no settle, no re-centre', () => {
    const offscreen = { top: -900, bottom: -860 };
    expect(recentreNeeded({ moved: 0, settle: false, list: LIST, row: offscreen })).toBe(false);
  });

  it('at the settle a row left outside the list re-centres; one inside stays', () => {
    const hidden = { top: 40, bottom: 80 };
    const shown = { top: 280, bottom: 330 };
    expect(recentreNeeded({ moved: 0, settle: true, list: LIST, row: hidden })).toBe(true);
    expect(recentreNeeded({ moved: 0, settle: true, list: LIST, row: shown })).toBe(false);
  });

  it('a reader gesture or the end of the window lets go', () => {
    expect(holdActive({ source: 'program', now: 1_000, until: 2_000 })).toBe(true);
    expect(holdActive({ source: 'user', now: 1_000, until: 2_000 })).toBe(false);
    expect(holdActive({ source: 'program', now: 2_001, until: 2_000 })).toBe(false);
  });
});

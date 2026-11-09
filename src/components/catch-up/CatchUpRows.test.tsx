// @vitest-environment jsdom
// Date + New on one line (Slack parity, 9 Nov 2026): when the first unread
// row starts a new day, the day line and the New line are ONE line (day left,
// "New" right, one ink hairline); apart, each stays alone; a single-day card
// has no day line.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DayNewLine, dividersAt } from '@/components/catch-up/CatchUpRows';
import { dayBreaks } from '@/lib/catch-up/text';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rows = (...at: string[]) => at.map((createdAt, k) => ({ id: `r${k}`, createdAt }));

/** Every divider the card draws, in row order. */
function drawn(list: { id: string; createdAt: string }[], firstNewId: string | null): string[] {
  const breaks = dayBreaks(list, 'UTC');
  return list.flatMap((row, i) => {
    const d = dividersAt(i, row.id, breaks, firstNewId);
    return d === null ? [] : [`${d}@${row.id}`];
  });
}

describe('day line and New line', () => {
  it('the first unread row starts a new day: one combined line, never two', () => {
    const list = rows('2026-11-07T10:00:00Z', '2026-11-07T11:00:00Z', '2026-11-08T09:00:00Z');
    expect(drawn(list, 'r2')).toEqual(['day@r0', 'day-new@r2']);
  });

  it('the first unread row mid-day: the New line alone, the day lines unchanged', () => {
    const list = rows('2026-11-07T10:00:00Z', '2026-11-08T09:00:00Z', '2026-11-08T10:00:00Z');
    expect(drawn(list, 'r2')).toEqual(['day@r0', 'day@r1', 'new@r2']);
  });

  it('a single-day card: no day line, the New line alone', () => {
    const list = rows('2026-11-08T09:00:00Z', '2026-11-08T10:00:00Z');
    expect(drawn(list, 'r1')).toEqual(['new@r1']);
    expect(drawn(list, null)).toEqual([]);
  });
});

describe('DayNewLine', () => {
  let root: Root | null = null;
  let host: HTMLDivElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = '';
  });

  it('one separator: day left, one ink hairline, ink "New" right', () => {
    act(() =>
      root?.render(
        <ul>
          <DayNewLine at="2026-11-07T10:00:00Z" timeZone="UTC" />
        </ul>,
      ),
    );
    const seps = host.querySelectorAll('[role="separator"]');
    expect(seps).toHaveLength(1);
    const line = seps[0] as HTMLElement;
    // The fill rule and the visual waits find it as the New line.
    expect(line.hasAttribute('data-new-line')).toBe(true);
    const parts = [...line.children] as HTMLElement[];
    expect(parts.map((p) => Object.keys(p.dataset)[0])).toEqual([
      'catchUpDayLabel',
      'newRule',
      'newPill',
    ]);
    expect(parts[0]?.textContent).not.toBe('');
    expect(parts[2]?.textContent).toBe('New');
    expect(line.querySelectorAll('[data-new-rule]')).toHaveLength(1);
    // Ink, never coloured; tokens only, so light and dark flip together.
    expect(parts[1]?.className).toContain('bg-fg');
    expect(parts[2]?.className).toContain('bg-fg');
    expect(line.innerHTML).not.toMatch(/\b(bg|text)-(good|accent|bad|amber|green)/);
    expect(line.innerHTML).not.toMatch(/dark:/);
  });
});

// @vitest-environment jsdom
// Date + New on one line (Slack parity, 9 Nov 2026): when the first unread
// row starts a new day, the day line and the New line are ONE line (day left,
// "New" right, one ink hairline); apart, each stays alone; a single-day card
// has no day line.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DayNewLine,
  dividersAt,
  EventRow,
  MessageRow,
  NewLine,
} from '@/components/catch-up/CatchUpRows';
import type { CatchUpEventRow, CatchUpMessageRow } from '@/lib/catch-up/body';
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

  it('one separator: day left, one thin bad rule, "NEW" (bad, meta, no pill) right', () => {
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
      'newWord',
    ]);
    expect(parts[0]?.textContent).not.toBe('');
    expect(parts[2]?.textContent).toBe('New');
    expect(line.querySelectorAll('[data-new-rule]')).toHaveLength(1);
    expect(line.querySelector('[data-new-pill]')).toBeNull();
    // The bad token, rule and word alike; tokens only, so light and dark flip together.
    expect(parts[1]?.className.split(' ')).toEqual(expect.arrayContaining(['h-px', 'bg-bad']));
    expect(parts[2]?.className.split(' ')).toEqual(
      expect.arrayContaining(['text-bad', 'uppercase', 'font-semibold', 'font-mono']),
    );
    expect(parts[2]?.className).not.toMatch(/\b(bg-|rounded-full)/);
    expect(line.innerHTML).not.toMatch(/dark:/);
  });

  it('the New line alone: the same rule and word, data-new-line kept', () => {
    act(() =>
      root?.render(
        <ul>
          <NewLine />
        </ul>,
      ),
    );
    const line = host.querySelector('[data-new-line]') as HTMLElement;
    const parts = [...line.children] as HTMLElement[];
    expect(parts.map((p) => Object.keys(p.dataset)[0])).toEqual(['newRule', 'newWord']);
    expect(parts[0]?.className).toContain('bg-bad');
    expect(parts[1]?.className).toContain('text-bad');
  });
});

// The message family on a card (11 Nov 2026): a phone draws the name in the
// family name token and the text in the message text token; laptop keeps the
// label name and the body text. The text that opens its thread adds no height
// (its 44 tap is a hit area), so name to text is the same 4 step for a one
// line and a two line comment.
describe('message family rows', () => {
  let root: Root | null = null;
  let host: HTMLDivElement;

  const message: CatchUpMessageRow = {
    kind: 'message',
    id: 'm1',
    author: { id: 'u1', name: 'Priya Shah', avatarUrl: null },
    createdAt: '2026-11-07T10:00:00Z',
    text: 'One line',
    replyCount: 0,
  };

  function setWidth(laptop: boolean): void {
    vi.stubGlobal(
      'matchMedia',
      (media: string): Partial<MediaQueryList> => ({
        media,
        matches: laptop && media.includes('min-width'),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    );
  }

  function draw(laptop: boolean): void {
    setWidth(laptop);
    act(() =>
      root?.render(
        <ul>
          <MessageRow row={message} selfName={null} timeZone="UTC" onOpenThread={() => undefined} />
        </ul>,
      ),
    );
  }

  const classesOf = (selector: string): string[] =>
    (host.querySelector(selector)?.className ?? '').split(' ');

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('phone: name 17 bold (the family name token), text 17/20 (msg)', () => {
    draw(false);
    const name = classesOf('[data-catch-up-name]');
    expect(name).toEqual(expect.arrayContaining(['text-xl', 'font-bold', 'truncate', 'text-fg']));
    expect(name).not.toContain('text-base');
    expect(name).not.toContain('font-medium');
    const text = classesOf('[data-catch-up-text]');
    expect(text).toEqual(expect.arrayContaining(['text-msg', 'font-normal']));
    expect(text).not.toContain('text-base');
  });

  it("laptop: today's label name and body text, unchanged", () => {
    draw(true);
    const name = classesOf('[data-catch-up-name]');
    expect(name).toEqual(expect.arrayContaining(['text-base', 'font-medium']));
    expect(name).not.toContain('text-xl');
    expect(name).not.toContain('font-bold');
    const text = classesOf('[data-catch-up-text]');
    expect(text).toEqual(expect.arrayContaining(['text-base', 'font-normal']));
    expect(text).not.toContain('text-msg');
  });

  it('the text that opens its thread adds no height: 44 tap from a hit area', () => {
    for (const laptop of [false, true]) {
      draw(laptop);
      const open = classesOf('[data-catch-up-open-thread]');
      expect(open).not.toContain('min-h-11');
      expect(open).toEqual(
        expect.arrayContaining(['relative', 'min-h-0', 'before:absolute', 'before:h-11']),
      );
      // The text sits above the hit area, so its links keep their own taps.
      const text = host.querySelector('[data-catch-up-open-thread] [data-catch-up-text]');
      expect(text?.parentElement?.className).toContain('relative');
    }
  });

  it('name line then text: one column, 4 apart, the name line never padded', () => {
    draw(false);
    const name = host.querySelector('[data-catch-up-name]');
    const column = name?.parentElement?.parentElement;
    expect(column?.className.split(' ')).toEqual(expect.arrayContaining(['flex-col', 'gap-1']));
    const line = (name?.parentElement?.className ?? '').split(' ');
    expect(line).toContain('items-baseline');
    expect(line.filter((c) => /^(min-h|h|py|pt|pb)-/.test(c))).toEqual([]);
  });

  it('long text: the head, then "more" outside the open-thread button; "more" unfolds in place', () => {
    const long = { ...message, text: Array.from({ length: 300 }, (_, k) => `w${k}`).join(' ') };
    const onOpen = vi.fn();
    setWidth(false);
    act(() =>
      root?.render(
        <ul>
          <MessageRow row={long} selfName={null} timeZone="UTC" onOpenThread={onOpen} />
        </ul>,
      ),
    );
    const more = host.querySelector<HTMLButtonElement>('[data-catch-up-more]');
    expect(more).not.toBeNull();
    expect(more?.closest('[data-catch-up-open-thread]')).toBeNull();
    expect(host.textContent).not.toContain('w299');
    act(() => more?.click());
    expect(onOpen).not.toHaveBeenCalled();
    expect(host.querySelector('[data-catch-up-more]')).toBeNull();
    expect(host.textContent).toContain('w299');
    // In place: no inner scroll box, no window.
    expect(host.querySelector('[data-catch-up-more-window]')).toBeNull();
    expect(host.innerHTML).not.toContain('overflow-y-auto');
  });

  it('an event line takes the same text token', () => {
    const event: CatchUpEventRow = {
      kind: 'event',
      id: 'e1',
      author: message.author,
      createdAt: message.createdAt,
      line: 'approved the post',
    };
    setWidth(false);
    act(() =>
      root?.render(
        <ul>
          <EventRow row={event} timeZone="UTC" />
        </ul>,
      ),
    );
    expect(classesOf('[data-catch-up-event] [data-catch-up-text]')).toContain('text-msg');
  });
});

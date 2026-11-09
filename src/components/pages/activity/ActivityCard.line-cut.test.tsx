// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 9 Nov 2026 (locked): an Activity line is one paragraph (actor, text, time
// inline) of at most 3 lines; past that it is cut at the last WHOLE word with
// "… more" before the time, measured on an off-screen clone. "… more" unfolds
// that line in place (" less" folds it); neither navigates. Hiding only 1-2
// words shows the text in full. A tap elsewhere opens the spot.

vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
  useHoverPointer: () => true,
}));

vi.mock('@/lib/workspace-context', async (importOriginal) => ({
  workspaceDisplayName: (await importOriginal<typeof import('@/lib/workspace-context')>())
    .workspaceDisplayName,
  useWorkspace: () => ({ workspaceKey: 'gbl' }),
}));

import { ActivityCard, cutLine, LINE_MAX_LINES } from '@/components/pages/activity/ActivityCard';
import type { ActivityItem } from '@/components/pages/activity/data';
import type { PresignCache } from '@/lib/asset-presign';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A fake layout: 40 characters per 20px line, 300 wide. */
const CHARS_PER_LINE = 40;
const fitsBy =
  (budget: number, full: string) =>
  (candidate: string | null): boolean =>
    (candidate === null ? full.length : candidate.length + '… more'.length) <= budget;

describe('cutLine (pure)', () => {
  it('null when the whole text fits', () => {
    expect(cutLine('short text', fitsBy(100, 'short text'))).toBeNull();
  });

  it('cuts at the last whole word that fits, never mid-word', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
    const cut = cutLine(text, fitsBy(30, text));
    expect(cut).toBe('alpha beta gamma delta');
    expect(text.startsWith(cut ?? '')).toBe(true);
  });

  it('strips trailing punctuation before the marker', () => {
    const text = 'one, two, three, four, five, six, seven, eight, nine, ten';
    // "one, two, three, four" + "… more" is 27 > 26: three words fit, the comma goes.
    const cut = cutLine(text, fitsBy(26, text));
    expect(cut?.endsWith(',')).toBe(false);
    expect(cut).toBe('one, two, three');
  });

  it('hiding only 1-2 words shows the text in full', () => {
    const text = 'aa bb cc dd ee ff';
    // Fits up to 4 words with the marker: 2 hidden -> full.
    const fits = (c: string | null): boolean => c !== null && c.split(' ').length <= 4;
    expect(cutLine(text, fits)).toBeNull();
  });
});

const cache = {} as unknown as PresignCache;
const NOW = Date.parse('2026-06-14T12:00:00.000Z');
const LONG = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');

function entry(over: Partial<ActivityItem>): ActivityItem {
  return {
    id: 'e1',
    workspaceId: 'w1',
    number: null,
    eventType: 'comment',
    entityType: 'post',
    entityId: 'p1',
    scope: 'posts',
    tier: 'active',
    createdAt: '2026-06-14T10:00:00.000Z',
    readAt: null,
    snoozedUntil: null,
    commentId: 'cm1',
    assetId: null,
    toStage: null,
    fromStage: null,
    title: 'Q3 Launch',
    actorId: null,
    actorName: 'Priya',
    actorAvatarUrl: null,
    body: null,
    format: null,
    caption: null,
    thumbnailAssetVersionId: null,
    pointsAdded: null,
    checkpointTotal: null,
    batchId: null,
    messageId: null,
    channelType: null,
    ...over,
  };
}

let root: Root | null = null;
const realRect = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  // Paragraphs measure by their text: 300 wide, 20 per 40 characters.
  HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement): DOMRect {
    const isLine = this.matches('[data-activity-line-body]');
    const lines = Math.max(1, Math.ceil((this.textContent ?? '').length / CHARS_PER_LINE));
    return {
      width: isLine ? 300 : 0,
      height: isLine ? lines * 20 : 0,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
  // jsdom has no line height: the measure falls back to the body role's 20.
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  HTMLElement.prototype.getBoundingClientRect = realRect;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function mount(group: ActivityItem[]): ReturnType<typeof vi.fn> {
  const onOpenEntry = vi.fn();
  act(() =>
    root?.render(
      <ActivityCard
        group={group}
        nowMs={NOW}
        timeZone="UTC"
        cache={cache}
        presignEnabled={false}
        onOpenGroup={vi.fn()}
        onOpenEntry={onOpenEntry}
        selfName={null}
      />,
    ),
  );
  return onOpenEntry;
}

const q = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);

describe('Activity line: short, long, more, less, navigate', () => {
  it('a short comment shows in full with no marker; the time ends the paragraph', () => {
    mount([entry({ body: 'Looks good' })]);
    expect(q('[data-activity-line-more]')).toBeNull();
    expect(q('[data-activity-line-text]')?.textContent).toBe('Looks good');
    const body = q<HTMLElement>('[data-activity-line-body]');
    expect(body?.lastElementChild?.hasAttribute('data-activity-line-time')).toBe(true);
    expect(body?.className).not.toMatch(/line-clamp|text-ellipsis|truncate/);
  });

  it(`a long comment cuts at a whole word inside ${LINE_MAX_LINES} lines with "… more" before the time`, () => {
    mount([entry({ body: LONG })]);
    const shown = q('[data-activity-line-text]')?.textContent ?? '';
    expect(shown.length).toBeLessThan(LONG.length);
    expect(LONG.startsWith(shown)).toBe(true);
    expect(LONG.charAt(shown.length)).toBe(' ');
    expect(q('[data-activity-line-marker]')?.textContent).toBe('…\u00a0');
    const toggle = q<HTMLButtonElement>('[data-activity-line-more]');
    expect(toggle?.textContent).toBe('more');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    // The marker sits right before the time.
    expect(toggle?.nextElementSibling?.hasAttribute('data-activity-line-time')).toBe(true);
    const body = q<HTMLElement>('[data-activity-line-body]');
    expect(body?.textContent?.length ?? 0).toBeLessThanOrEqual(LINE_MAX_LINES * CHARS_PER_LINE);
  });

  it('"more" unfolds that line in place, "less" folds it; neither navigates', () => {
    const onOpen = mount([entry({ body: LONG })]);
    act(() => q<HTMLButtonElement>('[data-activity-line-more]')?.click());
    expect(q('[data-activity-line-text]')?.textContent).toBe(LONG);
    const less = q<HTMLButtonElement>('[data-activity-line-more]');
    expect(less?.textContent).toBe('less');
    expect(q('[data-activity-line-marker]')?.textContent).toBe('\u00a0');
    expect(less?.getAttribute('aria-expanded')).toBe('true');
    act(() => less?.click());
    expect(q('[data-activity-line-more]')?.textContent).toBe('more');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('a tap anywhere else opens the exact spot (that entry only)', () => {
    const e = entry({ body: LONG });
    const onOpen = mount([e]);
    act(() => q<HTMLElement>('[data-activity-line-open]')?.click());
    expect(onOpen).toHaveBeenCalledWith(e);
  });

  it('the accessible name carries the FULL text; the hit overlay splits the line gap past the text', () => {
    mount([entry({ body: LONG })]);
    const open = q<HTMLElement>('[data-activity-line-open]');
    expect(open?.getAttribute('aria-label')).toContain(LONG);
    expect(open?.getAttribute('aria-label')).toContain('Priya');
    // Above + below = one line gap (8 / 12 / 16): neighbouring hits meet, never overlap.
    expect(open?.className.split(' ')).toEqual(
      expect.arrayContaining(['-top-1', '-bottom-2', 'compact:-bottom-1', 'calm:-top-2']),
    );
    expect(open?.className).toContain('min-h-0');
  });

  it('the time is tied to the last word by a no-break space (never alone on a line)', () => {
    mount([entry({ body: 'see slide 3.' })]);
    const body = q<HTMLElement>('[data-activity-line-body]');
    const time = q<HTMLElement>('[data-activity-line-time]');
    const before = time?.previousSibling;
    expect(before?.nodeType).toBe(Node.TEXT_NODE);
    expect(before?.textContent?.endsWith('\u00a0')).toBe(true);
    expect(body?.textContent).not.toMatch(/ \S+$/);
  });

  it('the dot slot stays when read, so the text never shifts', () => {
    mount([entry({ body: 'ok', readAt: '2026-06-14T11:00:00.000Z' })]);
    expect(q('[data-activity-line-dot-slot]')).not.toBeNull();
    expect(q('[data-activity-line-dot]')).toBeNull();
  });

  it('the photo hangs in the picture column (-ml-8 w-8), no reactions', () => {
    mount([entry({ body: 'ok' })]);
    expect(q('[data-activity-line-photo]')?.className).toContain('-ml-8');
    expect(q('[data-activity-line-photo]')?.className).toContain('w-8');
    expect(q('[data-reaction], [data-reactions]')).toBeNull();
  });
});

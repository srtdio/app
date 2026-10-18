// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { InductionState, Rect } from '@/lib/induction';
import { ROUTE_SCRIPTS } from '@/lib/induction-routes';
import type { Step } from '@/lib/induction-model';
import type { GuideFactsRead } from './induction-data';

const { media, facts } = vi.hoisted(() => ({
  media: { laptop: false },
  facts: { current: undefined as unknown as GuideFactsRead, reads: 0 },
}));

vi.mock('@/lib/use-media-query', () => ({
  LAPTOP_QUERY: '(min-width: 768px)',
  useMediaQuery: () => media.laptop,
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('./induction-data', () => ({
  readGuideFacts: async () => {
    facts.reads += 1;
    return facts.current;
  },
  NO_SAMPLE: { seeded: false, reviewPostId: null, postIds: [] },
  seedSampleWeek: async () => false,
  clearSampleWeek: async () => true,
  loadSampleAssets: async () => undefined,
  forgetKnownGroups: () => undefined,
}));

import { AvatarMenu } from '@/components/shell/AvatarMenu';
import { InductionGuide } from './InductionGuide';
import { InductionProvider } from './InductionProvider';
import { eventTrust } from './guide-hooks';
import type { InductionData } from './useInductionData';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE_FACTS: GuideFactsRead = {
  sample: { seeded: false, reviewPostId: null, postIds: [] },
  group: { name: 'Kite', channelId: 'group__ws-1__g1' },
  reviewPost: undefined,
  hasBrief: true,
  hasPlan: true,
  hasVoiceNote: true,
  ownPostTitle: 'Diwali drop',
};

const ALL_DATA = { postId: 'p1', clientInvited: true, teamInvited: true };

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let current: InductionData | null = null;

let trust: MockInstance<(event: Event) => boolean>;

beforeEach(() => {
  // jsdom marks dispatched events untrusted; the tests stand in for real taps.
  trust = vi.spyOn(eventTrust, 'isTrusted').mockReturnValue(true);
  host = document.createElement('div');
  document.body.appendChild(host);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
  media.laptop = false;
  facts.current = BASE_FACTS;
  facts.reads = 0;
  try {
    window.localStorage.clear();
  } catch {
    // No storage: the legend just shows.
  }
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function data(state: Partial<InductionState>): InductionData {
  return {
    status: 'ready',
    state: {
      step: null,
      done: false,
      role: 'owner',
      postId: null,
      clientInvited: false,
      teamInvited: false,
      ...state,
    },
    setStep: vi.fn(async () => true),
    finish: vi.fn(),
    restart: vi.fn(),
    setPolling: vi.fn(),
  };
}

/** A real control in the page whose rect the test sets (jsdom has no layout). */
function control(
  key: string,
  rect: Rect,
  options: { tag?: string; parent?: HTMLElement; attrs?: Record<string, string> } = {},
): { el: HTMLElement; move: (r: Rect) => void } {
  const el = document.createElement(options.tag ?? 'button');
  el.setAttribute('data-induction', key);
  for (const [name, value] of Object.entries(options.attrs ?? {})) el.setAttribute(name, value);
  let now = rect;
  el.getBoundingClientRect = () =>
    ({
      ...now,
      x: now.left,
      y: now.top,
      right: now.left + now.width,
      bottom: now.top + now.height,
      toJSON: () => ({}),
    }) as DOMRect;
  (options.parent ?? document.body).appendChild(el);
  return { el, move: (r) => (now = r) };
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
    else await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Shows the router location, so tests can read where the guide navigated. */
function Where(): ReactElement {
  const location = useLocation();
  return <output data-where={`${location.pathname}${location.search}`} />;
}

function where(): string {
  return q('[data-where]').getAttribute('data-where') ?? '';
}

function render(d: InductionData, options: { route?: string; canCreateBrief?: boolean | null }) {
  root!.render(
    <MemoryRouter initialEntries={[options.route ?? '/pipeline']}>
      <InductionProvider
        data={d}
        workspaceId="ws-1"
        workspaceLabel="Kite - Instagram"
        canCreateBrief={options.canCreateBrief ?? null}
      >
        <Where />
        <InductionGuide tabsShown />
      </InductionProvider>
    </MemoryRouter>,
  );
}

async function mount(
  state: Partial<InductionState>,
  options: { route?: string; canCreateBrief?: boolean | null } = {},
): Promise<InductionData> {
  current = data(state);
  root = createRoot(host!);
  await act(async () => {
    render(current!, options);
  });
  // The facts read resolves, then the control settles (SETTLE_MS) and the box shows.
  await wait(160);
  return current;
}

function q<T extends Element = HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  return el;
}

function px(el: HTMLElement, prop: 'top' | 'left' | 'width' | 'height' | 'bottom'): number {
  return Number.parseFloat(el.style[prop]);
}

function stepFor(route: keyof typeof ROUTE_SCRIPTS, key: string): Step {
  const found = ROUTE_SCRIPTS[route].steps.find((s) => s.targets.includes(key as never));
  if (found === undefined) throw new Error(`no ${route} step for ${key}`);
  return found;
}

function nextOf(route: keyof typeof ROUTE_SCRIPTS, id: string): string {
  const steps = ROUTE_SCRIPTS[route].steps;
  return steps[steps.findIndex((s) => s.id === id) + 1]?.id ?? '';
}

const CHIP = { top: 120, left: 16, width: 120, height: 44 };

describe('the spotlight', () => {
  it('draws the hairline 7px off the live control, radius 12 for a small radius', async () => {
    control('pipeline-approved-chip', CHIP);
    await mount({ step: 'c_approved_chip' });
    const box = q('[data-induction-box]');
    expect([px(box, 'top'), px(box, 'left'), px(box, 'width'), px(box, 'height')]).toEqual([
      113, 9, 134, 58,
    ]);
    expect(box.style.borderRadius).toBe('12px');
  });

  it('takes radius 16 for a rounder control', async () => {
    const c = control('pipeline-approved-chip', CHIP);
    c.el.style.borderTopLeftRadius = '22px';
    await mount({ step: 'c_approved_chip' });
    expect(q('[data-induction-box]').style.borderRadius).toBe('16px');
  });

  it('dims with the box shadow, takes no pointer, and draws the hand and the label below', async () => {
    control('pipeline-approved-chip', CHIP);
    await mount({ step: 'c_approved_chip' });
    const box = q('[data-induction-box]');
    expect(box.className).toContain('pointer-events-none');
    expect(box.className).toMatch(/shadow-\[0_0_0_200vmax_rgba\(14,16,30,0\.30\)\]/);
    expect(q('[data-induction-hand]').className).toContain('pointer-events-none');
    const label = q('[data-induction-label]');
    expect(label.textContent).toBe('Tap Approved to filter');
    expect(px(label, 'top')).toBeGreaterThanOrEqual(113 + 58);
  });

  it('follows the control when it moves, after it settles', async () => {
    const c = control('pipeline-approved-chip', CHIP);
    await mount({ step: 'c_approved_chip' });
    c.move({ ...CHIP, top: 60 });
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });
    await wait(200);
    expect(px(q('[data-induction-box]'), 'top')).toBe(53);
  });

  it('shows only the bar while the control is not on screen', async () => {
    await mount({ step: 'c_approved_chip' });
    expect(document.querySelector('[data-induction-box]')).toBeNull();
    expect(document.querySelector('[data-induction-label]')).toBeNull();
    expect(document.querySelector('[data-induction-bar]')).not.toBeNull();
  });

  it('picks the review post row by its id on the approver route', async () => {
    facts.current = {
      ...BASE_FACTS,
      reviewPost: { id: 'p2', title: 'Diwali drop', creatorName: 'Asha' },
    };
    control(
      'pipeline-post-row',
      { top: 100, left: 16, width: 358, height: 60 },
      {
        attrs: { 'data-induction-post': 'p1' },
      },
    );
    control(
      'pipeline-post-row',
      { top: 300, left: 16, width: 358, height: 60 },
      {
        attrs: { 'data-induction-post': 'p2' },
      },
    );
    const open = stepFor('approver', 'pipeline-post-row');
    await mount({ role: 'client', step: open.id });
    expect(px(q('[data-induction-box]'), 'top')).toBe(293);
    expect(q('[data-induction-label]').textContent).toBe('Tap to open Diwali drop');
    expect(q('[data-induction-bar]').textContent).toContain('Asha sent it for your review.');
  });

  it('boxes nothing for a group row that is not the default group', async () => {
    const group = stepFor('creator', 'chat-default-group-row');
    control(
      'chat-default-group-row',
      { top: 100, left: 0, width: 390, height: 60 },
      {
        attrs: { 'data-induction-channel': 'group__ws-1__other' },
      },
    );
    await mount({ step: group.id, ...ALL_DATA }, { route: '/chat' });
    expect(document.querySelector('[data-induction-box]')).toBeNull();
  });
});

describe('the guide bar', () => {
  it('docks at the bottom for a control up top, with the phase, progress and why line', async () => {
    control('pipeline-approved-chip', CHIP);
    await mount({ step: 'c_approved_chip' });
    const bar = q('[data-induction-bar]');
    expect(bar.getAttribute('data-induction-bar')).toBe('bottom');
    expect(bar.textContent).toContain('Step 2');
    expect(bar.textContent).toContain('Every post sits in one of five stages.');
    // No own post yet: the review steps drop out of the count.
    const steps = ROUTE_SCRIPTS.creator.steps.filter(
      (s) => !(s.skipWhen ?? []).includes('noOwnPost'),
    );
    const index = steps.findIndex((s) => s.id === 'c_approved_chip');
    const expected = (4 + index) / (4 + steps.length);
    const now = Number(q('[role="progressbar"]').getAttribute('aria-valuenow'));
    expect(now).toBe(Math.round(expected * 100));
  });

  it('docks at the top when the control is in the bottom third', async () => {
    control('pipeline-approved-chip', { top: 700, left: 16, width: 120, height: 44 });
    await mount({ step: 'c_approved_chip' });
    expect(q('[data-induction-bar]').getAttribute('data-induction-bar')).toBe('top');
  });

  it('names the current chapter on a look-around step', async () => {
    const activity = stepFor('creator', 'activity-tab');
    control('activity-tab', { top: 790, left: 300, width: 60, height: 44 });
    await mount({ step: activity.id, ...ALL_DATA });
    expect(q('[data-induction-bar]').textContent).toContain('Talk');
  });

  it('shows no bar on a step with nothing to add: the label is the one message', async () => {
    control('topbar-workspace-slot', { top: 8, left: 100, width: 190, height: 44 });
    root = createRoot(host!);
    current = data({ step: null });
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={['/pipeline']}>
          <InductionProvider data={current!} workspaceId={null} workspaceLabel="">
            <InductionGuide tabsShown={false} />
          </InductionProvider>
        </MemoryRouter>,
      );
    });
    await wait(160);
    expect(q('[data-induction-step]').getAttribute('data-induction-step')).toBe('c_workspace');
    expect(document.querySelector('[data-induction-bar]')).toBeNull();
    expect(document.body.textContent).toContain('Your brand first');
    expect(document.body.textContent).not.toContain('When the hand taps');
  });

  it('offers Skip tour, which ends the tour through finish recorded as skipped', async () => {
    control('pipeline-approved-chip', CHIP);
    const d = await mount({ step: 'c_approved_chip' });
    const skip = q<HTMLButtonElement>('[data-induction-bar] [data-induction-skip]');
    expect(skip.textContent).toBe('Skip tour');
    expect(skip.className).toContain('min-h-[44px]');
    act(() => skip.click());
    expect(d.finish).toHaveBeenCalledWith('c_skipped');
    expect(d.setStep).not.toHaveBeenCalled();
  });

  it('gives an optional step its later chip, which moves on', async () => {
    control('members-invite', { top: 200, left: 16, width: 358, height: 300 }, { tag: 'section' });
    const d = await mount(
      { step: 'c_team_invite', postId: 'p1', clientInvited: true },
      { route: '/settings?panel=members' },
    );
    // The chip shows at once: no scroll, no wait.
    const later = Array.from(document.querySelectorAll('[data-induction-bar] button')).find(
      (b) => b.textContent === "It's just me for now",
    );
    expect(later).toBeDefined();
    act(() => (later as HTMLButtonElement).click());
    expect(d.setStep).toHaveBeenCalledWith('c_intro');
  });
});

describe('after a refresh', () => {
  it('goes back to the control that reopens a closed sheet, quickly', async () => {
    // Stored on Continue, but the workspace form closed with the reload.
    control('topbar-workspace-slot', { top: 8, left: 100, width: 190, height: 44 });
    root = createRoot(host!);
    current = data({ step: 'c_workspace_continue' });
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={['/pipeline']}>
          <InductionProvider data={current!} workspaceId={null} workspaceLabel="">
            <InductionGuide tabsShown={false} />
          </InductionProvider>
        </MemoryRouter>,
      );
    });
    await wait(1000);
    // Well before the 4 s wait for a control that never shows.
    expect(current!.setStep).toHaveBeenCalledWith('c_workspace');
  });
});

describe('Back', () => {
  it('is hidden on the first step', async () => {
    control('topbar-workspace-slot', { top: 8, left: 100, width: 190, height: 44 });
    root = createRoot(host!);
    current = data({ step: null });
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={['/pipeline']}>
          <InductionProvider data={current!} workspaceId={null} workspaceLabel="">
            <InductionGuide tabsShown={false} />
          </InductionProvider>
        </MemoryRouter>,
      );
    });
    await wait(160);
    expect(q('[data-induction-step]').getAttribute('data-induction-step')).toBe('c_workspace');
    expect(document.querySelector('[data-induction-back]')).toBeNull();
  });

  it('goes to the previous step whose control is on screen', async () => {
    control('pipeline-approved-chip', CHIP);
    control('pipeline-create', { top: 120, left: 320, width: 44, height: 44 });
    const d = await mount({ step: 'c_post_create' });
    act(() => q('[data-induction-back]').click());
    expect(d.setStep).toHaveBeenCalledWith('c_approved_chip');
  });
});

describe('the guard', () => {
  it('swallows a tap outside the control and nudges the hand and label', async () => {
    control('pipeline-approved-chip', CHIP);
    const other = document.createElement('button');
    const pressed = vi.fn();
    other.addEventListener('click', pressed);
    document.body.appendChild(other);
    await mount({ step: 'c_approved_chip' });
    await act(async () => {
      other.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
      other.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(pressed).not.toHaveBeenCalled();
    expect(q('[data-induction-hand]').getAttribute('data-guide-nudge')).toBe('on');
    expect(q('[data-induction-label]').getAttribute('data-guide-nudge')).toBe('on');
  });

  it('lets the control do the real thing, then moves on after its own handler', async () => {
    const c = control('pipeline-approved-chip', CHIP);
    control('pipeline-create', { top: 120, left: 320, width: 44, height: 44 });
    const order: string[] = [];
    c.el.addEventListener('click', () => order.push('handler'));
    const d = await mount({ step: 'c_approved_chip' });
    vi.mocked(d.setStep).mockImplementation(async (id) => {
      order.push(`move:${id}`);
      return true;
    });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      c.el.dispatchEvent(click);
    });
    await wait(20);
    expect(click.defaultPrevented).toBe(false);
    expect(order).toEqual(['handler', `move:${nextOf('creator', 'c_approved_chip')}`]);
  });

  it('never swallows taps on the bar', async () => {
    control('pipeline-approved-chip', CHIP);
    await mount({ step: 'c_approved_chip' });
    const bar = q('[data-induction-bar]');
    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true });
    await act(async () => {
      bar.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(false);
  });

  it('leaves no listeners behind after unmount', async () => {
    const live = new Set<unknown>();
    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation((type, fn, opts) => {
      live.add(fn);
      add(type, fn, opts);
    });
    vi.spyOn(document, 'removeEventListener').mockImplementation((type, fn, opts) => {
      live.delete(fn);
      remove(type, fn, opts);
    });
    control('pipeline-approved-chip', CHIP);
    await mount({ step: 'c_approved_chip' });
    expect(live.size).toBeGreaterThan(0);
    act(() => root?.unmount());
    root = null;
    expect(live.size).toBe(0);
  });
});

describe('completion', () => {
  it('finishes a field step when it holds text and loses focus, not when empty', async () => {
    const field = control(
      'post-sheet-caption',
      { top: 300, left: 16, width: 358, height: 80 },
      {
        tag: 'textarea',
      },
    );
    const d = await mount({ step: 'c_post_caption' });
    const area = field.el as HTMLTextAreaElement;
    await act(async () => {
      area.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(d.setStep).not.toHaveBeenCalled();
    await act(async () => {
      area.value = 'Diwali drop';
      area.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(d.setStep).toHaveBeenCalledWith('c_post_format');
  });

  it('lets typing work in a field: taps on it are never swallowed', async () => {
    const field = control(
      'post-sheet-caption',
      { top: 300, left: 16, width: 358, height: 80 },
      {
        tag: 'textarea',
      },
    );
    await mount({ step: 'c_post_caption' });
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    await act(async () => {
      field.el.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(false);
  });

  it('finishes a field step when the next step control is tapped', async () => {
    control(
      'post-sheet-caption',
      { top: 300, left: 16, width: 358, height: 80 },
      {
        tag: 'textarea',
      },
    );
    const format = control('post-sheet-format', { top: 400, left: 16, width: 358, height: 44 });
    const d = await mount({ step: 'c_post_caption' });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    await act(async () => {
      format.el.dispatchEvent(click);
    });
    await wait(20);
    expect(click.defaultPrevented).toBe(false);
    expect(d.setStep).toHaveBeenCalledWith('c_post_format');
  });

  it('finishes when the next step control appears after being absent', async () => {
    control('pipeline-approved-chip', CHIP);
    const d = await mount({ step: 'c_approved_chip' });
    control('pipeline-create', { top: 120, left: 320, width: 44, height: 44 });
    await wait(40);
    expect(d.setStep).toHaveBeenCalledWith('c_post_create');
  });

  it('finishes when its own control disappears after a tap on it', async () => {
    const c = control('pipeline-approved-chip', CHIP);
    const d = await mount({ step: 'c_approved_chip' });
    await act(async () => {
      c.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      c.el.remove();
    });
    await wait(40);
    expect(d.setStep).toHaveBeenCalledWith('c_post_create');
  });

  it('never finishes a gate by a tap: the data does', async () => {
    const primary = control('post-sheet-primary', { top: 780, left: 250, width: 120, height: 44 });
    const d = await mount({ step: 'c_post_send' });
    await act(async () => {
      primary.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(d.setStep).not.toHaveBeenCalled();
  });
});

describe('the 4 s skip', () => {
  it('moves to the next visible step on the same screen when the control never shows', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const add = stepFor('approver', 'briefs-new');
    const title = stepFor('approver', 'brief-sheet-title');
    control('brief-sheet-title', { top: 200, left: 16, width: 358, height: 44 }, { tag: 'input' });
    const d = await mount(
      { role: 'client', step: add.id },
      { route: '/briefs', canCreateBrief: true },
    );
    expect(d.setStep).not.toHaveBeenCalled();
    await wait(4000);
    expect(d.setStep).toHaveBeenCalledWith(title.id);
  });

  it('does not skip a control that showed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    control('pipeline-approved-chip', CHIP);
    const d = await mount({ step: 'c_approved_chip' });
    await wait(4500);
    expect(d.setStep).not.toHaveBeenCalled();
  });
});

describe('cards', () => {
  it('shows the intro before the look-around, and Start stores the first look-around step', async () => {
    const d = await mount({ step: 'c_intro', ...ALL_DATA });
    const card = q('[data-induction-card="intro"]');
    expect(card.textContent).toContain('Have a look around');
    expect(card.textContent).toContain('KESTREL & ROWE · SAMPLE WEEK');
    const start = Array.from(card.querySelectorAll('button')).find(
      (b) => b.textContent === 'Start',
    )!;
    act(() => start.click());
    const first = ROUTE_SCRIPTS.creator.steps.find((s) => s.chapter !== undefined)!;
    expect(d.setStep).toHaveBeenCalledWith(first.id);
  });

  it('shows the closing card when nothing is left, and Done finishes', async () => {
    const d = await mount({ step: 'c_closing', ...ALL_DATA });
    const card = q('[data-induction-card="closing"]');
    expect(card.textContent).toContain('Diwali drop is waiting for your approver.');
    act(() => card.querySelector('button')!.click());
    expect(d.finish).toHaveBeenCalledTimes(1);
  });
});

describe('sample week', () => {
  it('shows the clear card before the closing card while the sample is there', async () => {
    facts.current = {
      ...BASE_FACTS,
      sample: { seeded: true, reviewPostId: 'p-sample', postIds: ['p-sample'] },
    };
    await mount({ step: 'c_closing', ...ALL_DATA });
    const card = q('[data-induction-card="clear"]');
    expect(card.textContent).toContain("That was Kestrel & Rowe's week");
    expect(card.textContent).toContain('things you did');
    expect(card.querySelector('button')?.textContent).toBe('Clear it');
    expect(document.querySelector('[data-induction-card="closing"]')).toBeNull();
    facts.current = BASE_FACTS;
  });
});

describe('fix round regressions', () => {
  it('does not finish a sheet field step when its fields mount a frame late', async () => {
    const d = await mount({ step: 'c_post_caption' });
    // The sheet renders its content after it opens: caption and format land together.
    await act(async () => {
      control(
        'post-sheet-caption',
        { top: 300, left: 16, width: 358, height: 80 },
        {
          tag: 'textarea',
        },
      );
      control('post-sheet-format', { top: 400, left: 16, width: 358, height: 44 });
    });
    await wait(200);
    expect(d.setStep).not.toHaveBeenCalled();
    expect(q('[data-induction-label]').textContent).toBe('Tap to write the caption');
  });

  it('keeps the step when a tap does nothing (the action failed)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const c = control('pipeline-approved-chip', CHIP);
    const d = await mount({ step: 'c_approved_chip' });
    await act(async () => {
      c.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await wait(4500);
    expect(d.setStep).not.toHaveBeenCalled();
    expect(document.querySelector('[data-induction-box]')).not.toBeNull();
  });

  it('does not confirm a tap while a modal covers the next control', async () => {
    const c = control('pipeline-approved-chip', CHIP);
    control('pipeline-create', { top: 120, left: 320, width: 44, height: 44 });
    const d = await mount({ step: 'c_approved_chip' });
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.getBoundingClientRect = () =>
      ({ top: 400, left: 0, width: 390, height: 444, right: 390, bottom: 844 }) as DOMRect;
    await act(async () => {
      c.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      document.body.appendChild(dialog);
    });
    await wait(40);
    // The chip is covered too, which counts as it disappearing: that alone finishes it.
    expect(d.setStep).toHaveBeenCalledTimes(1);
  });

  it('boxes nothing when a modal that does not hold the control covers it', async () => {
    control('pipeline-approved-chip', CHIP);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.getBoundingClientRect = () =>
      ({ top: 300, left: 0, width: 390, height: 544, right: 390, bottom: 844 }) as DOMRect;
    document.body.appendChild(dialog);
    await mount({ step: 'c_approved_chip' });
    expect(document.querySelector('[data-induction-box]')).toBeNull();
    expect(document.querySelector('[data-induction-bar]')).not.toBeNull();
  });

  it('opens the next step place instead of jumping to the always-visible Activity tab', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const steps = ROUTE_SCRIPTS.creator.steps;
    const brief = stepFor('creator', 'briefs-first-card');
    control('activity-tab', { top: 790, left: 300, width: 60, height: 44 });
    const d = await mount({ step: brief.id, ...ALL_DATA }, { route: '/briefs' });
    await wait(4000);
    const next = steps[steps.findIndex((s) => s.id === brief.id) + 1];
    expect(d.setStep).toHaveBeenCalledWith(next?.id);
    expect(d.setStep).not.toHaveBeenCalledWith(stepFor('creator', 'activity-tab').id);
  });

  it('opens a new step place when the location is elsewhere', async () => {
    const brief = stepFor('creator', 'briefs-first-card');
    await mount({ step: brief.id, ...ALL_DATA }, { route: '/pipeline' });
    expect(where()).toBe('/briefs');
  });

  it('keeps Back with nothing earlier on screen, going to the previous open step', async () => {
    control('pipeline-create', { top: 120, left: 320, width: 44, height: 44 });
    const d = await mount({ step: 'c_post_create' });
    act(() => q('[data-induction-back]').click());
    expect(d.setStep).toHaveBeenCalledWith('c_approved_chip');
  });

  it('docks the bar where it does not cover the box', async () => {
    control('pipeline-approved-chip', { top: 740, left: 16, width: 120, height: 44 });
    await mount({ step: 'c_approved_chip' });
    expect(q('[data-induction-bar]').getAttribute('data-induction-bar')).toBe('top');
  });

  it('uses the guide tokens for the hairline, pill and progress', async () => {
    control('pipeline-approved-chip', CHIP);
    await mount({ step: 'c_approved_chip' });
    expect(q('[data-induction-box]').className).toContain('border-[var(--guide)]');
    const label = q('[data-induction-label]').className;
    expect(label).toContain('bg-[var(--guide)]');
    expect(label).toContain('text-[var(--guide-ink)]');
    expect(q('[data-induction-progress]').className).toContain('bg-[var(--guide-deep)]');
    const dim = q('[data-induction-box]').className;
    expect(dim).toContain('shadow-[0_0_0_200vmax_rgba(14,16,30,0.30)]');
    expect(dim).toContain('dark:shadow-[0_0_0_200vmax_rgba(0,0,0,0.22)]');
    expect(q('[data-induction-box]').getAttribute('style')).not.toMatch(/shadow|rgba/);
  });

  it('reads the facts once per workspace, not on every poll, and again on refresh', async () => {
    control('pipeline-approved-chip', CHIP);
    await mount({ step: 'c_approved_chip' });
    expect(facts.reads).toBe(1);
    await act(async () => {
      render(data({ step: 'c_approved_chip' }), {});
    });
    await wait(20);
    expect(facts.reads).toBe(1);
    await act(async () => {
      window.dispatchEvent(new CustomEvent('sorted:induction-refresh'));
    });
    await wait(20);
    expect(facts.reads).toBe(2);
  });

  it('stops the frame loop once the control has settled', async () => {
    const frames = vi.spyOn(window, 'requestAnimationFrame');
    control('pipeline-approved-chip', CHIP);
    await mount({ step: 'c_approved_chip' });
    await wait(400);
    const settled = frames.mock.calls.length;
    await wait(200);
    expect(frames.mock.calls.length).toBe(settled);
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(frames.mock.calls.length).toBeGreaterThan(settled);
  });
});

describe('fix round 2 regressions', () => {
  it('lets a programmatic click through the guard (a button opening a hidden file input)', async () => {
    control('pipeline-approved-chip', CHIP);
    const input = document.createElement('input');
    input.type = 'file';
    const opened = vi.fn();
    input.addEventListener('click', opened);
    document.body.appendChild(input);
    await mount({ step: 'c_approved_chip' });
    trust.mockImplementation((event: Event) => event.isTrusted);
    await act(async () => {
      input.click();
    });
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('lets the gate form take taps while boxing only its submit button', async () => {
    const form = document.createElement('form');
    const email = document.createElement('input');
    email.type = 'email';
    form.appendChild(email);
    document.body.appendChild(form);
    const send = control(
      'members-invite',
      { top: 400, left: 16, width: 358, height: 44 },
      {
        parent: form,
        attrs: { type: 'submit' },
      },
    );
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    await mount({ step: 'c_approver_invite', postId: 'p1' }, { route: '/settings?panel=members' });
    const inField = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    const elsewhere = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    await act(async () => {
      email.dispatchEvent(inField);
      outside.dispatchEvent(elsewhere);
    });
    expect(inField.defaultPrevented).toBe(false);
    expect(elsewhere.defaultPrevented).toBe(true);
    const box = q('[data-induction-box]');
    expect(Number.parseFloat(box.style.top)).toBe(393);
    expect(send.el.parentElement).toBe(form);
  });

  it('confirms a tap on the last step, which has no next step: the closing card follows', async () => {
    const steps = ROUTE_SCRIPTS.creator.steps;
    const last = steps[steps.length - 1]!;
    const key = last.targets[0]!;
    const c = control(key, { top: 300, left: 16, width: 120, height: 44 });
    const d = await mount({ step: last.id, ...ALL_DATA }, { route: placeRouteFor(last) });
    await act(async () => {
      c.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await wait(20);
    expect(d.setStep).toHaveBeenCalledWith(ROUTE_SCRIPTS.creator.closing.id);
  });

  it('re-reads the facts on each refetch until the default group is known, then stops', async () => {
    facts.current = { ...BASE_FACTS, group: undefined };
    control('pipeline-approved-chip', CHIP);
    await mount({ step: 'c_approved_chip' });
    const first = facts.reads;
    await act(async () => {
      render(data({ step: 'c_approved_chip' }), {});
    });
    await wait(20);
    expect(facts.reads).toBe(first + 1);
    facts.current = BASE_FACTS;
    await act(async () => {
      render(data({ step: 'c_approved_chip' }), {});
    });
    await wait(20);
    const found = facts.reads;
    await act(async () => {
      render(data({ step: 'c_approved_chip' }), {});
    });
    await wait(20);
    expect(facts.reads).toBe(found);
  });
});

function placeRouteFor(step: Step): string {
  if (step.place === 'chat' || step.place === 'group') return '/chat';
  if (step.place === 'shell') return '/pipeline';
  return `/${step.place}`;
}

describe('dismissing a control', () => {
  it('keeps the step when its control goes away with no tap (a sheet closed by Escape)', async () => {
    const c = control('pipeline-approved-chip', CHIP);
    const d = await mount({ step: 'c_approved_chip' });
    await act(async () => {
      c.el.remove();
    });
    await wait(40);
    expect(d.setStep).not.toHaveBeenCalled();
  });
});

/** Re-render with the stored step moved, as induction_state would after setStep. */
async function moveStored(state: Partial<InductionState>): Promise<void> {
  current = data(state);
  await act(async () => {
    render(current!, {});
  });
}

describe('a finished step', () => {
  it('shows the next step at once, with no green tick', async () => {
    const chip = control('pipeline-approved-chip', CHIP);
    control('pipeline-create', { top: 120, left: 320, width: 44, height: 44 });
    await mount({ step: 'c_approved_chip' });
    await act(async () => {
      chip.el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
      chip.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await moveStored({ step: 'c_post_create' });
    expect(document.querySelector('[data-induction-result]')).toBeNull();
    await wait(150);
    expect(document.querySelector('[data-induction-result]')).toBeNull();
    expect(document.querySelector('[data-induction-box]')).not.toBeNull();
  });
});

describe('the opt-out', () => {
  async function teamInvite(): Promise<void> {
    control('members-invite', { top: 200, left: 16, width: 358, height: 300 }, { tag: 'section' });
    await mount(
      { step: 'c_team_invite', postId: 'p1', clientInvited: true },
      { route: '/settings?panel=members' },
    );
  }
  const later = (): HTMLButtonElement | undefined =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[data-induction-bar] button')).find(
      (b) => b.textContent === "It's just me for now",
    );

  it('shows at once with no scroll, then moves on quietly', async () => {
    await teamInvite();
    const button = later();
    expect(button).toBeDefined();
    act(() => button?.click());
    await moveStored({ step: 'c_intro', postId: 'p1', clientInvited: true });
    expect(document.querySelector('[data-induction-card="intro"]')).not.toBeNull();
  });
});

describe('the chapter dots', () => {
  it('marks finished chapters green, the current one amber, upcoming ones grey', async () => {
    const comment = stepFor('creator', 'post-comment-reply');
    control('post-comment-reply', { top: 300, left: 16, width: 120, height: 44 });
    await mount({ step: comment.id, ...ALL_DATA }, { route: '/posts/p1' });
    const dots = Array.from(document.querySelectorAll<HTMLElement>('[data-induction-chapter]'));
    expect(dots.map((d) => d.getAttribute('data-induction-chapter'))).toEqual([
      'done',
      'current',
      'upcoming',
    ]);
    expect(dots[0]!.className).toContain('bg-good');
    expect(dots[1]!.className).toContain('bg-[var(--guide)]');
    expect(dots[2]!.className).toContain('bg-border-strong');
  });
});

describe('a control whose action finished', () => {
  it('moves the guide on even when the tap was missed', async () => {
    control('pipeline-approved-chip', CHIP);
    const d = await mount({ step: 'c_approved_chip' });
    act(() => {
      window.dispatchEvent(
        new CustomEvent('sorted:induction-did', { detail: 'pipeline-approved-chip' }),
      );
    });
    expect(d.setStep).toHaveBeenCalledWith('c_post_create');
  });

  it('ignores another control', async () => {
    control('pipeline-approved-chip', CHIP);
    const d = await mount({ step: 'c_approved_chip' });
    act(() => {
      window.dispatchEvent(
        new CustomEvent('sorted:induction-did', { detail: 'post-comment-post' }),
      );
    });
    expect(d.setStep).not.toHaveBeenCalled();
  });
});

describe('W10 guided tour: Skip tour, Invite later, restart', () => {
  it('shows Skip tour on the intro card, which finishes recorded as skipped', async () => {
    const d = await mount({ step: 'c_intro', ...ALL_DATA });
    const skip = q<HTMLButtonElement>('[data-induction-card="intro"] [data-induction-skip]');
    expect(skip.textContent).toBe('Skip tour');
    act(() => skip.click());
    expect(d.finish).toHaveBeenCalledWith('c_skipped');
    expect(d.setStep).not.toHaveBeenCalled();
  });

  it('offers Invite later on the approver invite, which continues the tour', async () => {
    control('members-invite', { top: 200, left: 16, width: 358, height: 300 }, { tag: 'section' });
    const d = await mount(
      { step: 'c_approver_invite', postId: 'p1' },
      { route: '/settings?panel=members' },
    );
    expect(q('[data-induction-step]').getAttribute('data-induction-step')).toBe(
      'c_approver_invite',
    );
    const later = Array.from(document.querySelectorAll('[data-induction-bar] button')).find(
      (b) => b.textContent === 'Invite later',
    );
    expect(later).toBeDefined();
    act(() => (later as HTMLButtonElement).click());
    expect(d.setStep).toHaveBeenCalledWith('c_team_invite');
    expect(d.finish).not.toHaveBeenCalled();
  });

  it("shows It's just me for now at once, before any scroll or timer", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    control('members-invite', { top: 200, left: 16, width: 358, height: 300 }, { tag: 'section' });
    await mount(
      { step: 'c_team_invite', postId: 'p1', clientInvited: true },
      { route: '/settings?panel=members' },
    );
    const names = Array.from(document.querySelectorAll('[data-induction-bar] button')).map(
      (b) => b.textContent,
    );
    expect(names).toContain("It's just me for now");
  });

  it('restarts the tour for the current role from the avatar menu', async () => {
    media.laptop = true;
    current = data({ done: true, role: 'client', ...ALL_DATA });
    root = createRoot(host!);
    await act(async () => {
      root!.render(
        <MemoryRouter initialEntries={['/pipeline']}>
          <InductionProvider data={current!} workspaceId="ws-1" workspaceLabel="Kite - Instagram">
            <AvatarMenu open onClose={() => undefined} />
          </InductionProvider>
        </MemoryRouter>,
      );
    });
    const row = Array.from(document.querySelectorAll('[role="menuitem"]')).find(
      (b) => b.textContent === 'Restart tour',
    );
    expect(row).toBeDefined();
    act(() => (row as HTMLButtonElement).click());
    expect(current!.restart).toHaveBeenCalledWith(ROUTE_SCRIPTS.approver.intro.id);
  });
});

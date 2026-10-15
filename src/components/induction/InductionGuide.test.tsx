// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InductionState, Rect } from '@/lib/induction';

const { media } = vi.hoisted(() => ({ media: { laptop: false } }));

vi.mock('@/lib/use-media-query', () => ({ useMediaQuery: () => media.laptop }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('./induction-data', () => ({
  readDefaultGroup: async () => ({ name: 'Kite', channelId: 'group__ws-1__g1' }),
  readOldestReviewPost: async () => undefined,
}));

import { InductionGuide } from './InductionGuide';
import { InductionProvider } from './InductionProvider';
import type { InductionData } from './useInductionData';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
  media.laptop = false;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
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
    setPolling: vi.fn(),
  };
}

/** A real control in the page whose rect the test sets (jsdom has no layout). */
function control(
  key: string,
  rect: Rect,
  parent: HTMLElement = document.body,
): { move: (r: Rect) => void } {
  const el = document.createElement('button');
  el.setAttribute('data-induction', key);
  let current = rect;
  el.getBoundingClientRect = () =>
    ({
      ...current,
      x: current.left,
      y: current.top,
      right: current.left + current.width,
      bottom: current.top + current.height,
      toJSON: () => ({}),
    }) as DOMRect;
  parent.appendChild(el);
  return { move: (r) => (current = r) };
}

async function mount(state: Partial<InductionState>, route = '/pipeline'): Promise<void> {
  root = createRoot(host!);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[route]}>
        <InductionProvider data={data(state)} workspaceId="ws-1" workspaceLabel="Kite - Instagram">
          <InductionGuide tabsShown />
        </InductionProvider>
      </MemoryRouter>,
    );
  });
  // The places read resolves, then the guide renders.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function frame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

function boxStyle(): { top: number; left: number; width: number; height: number } {
  const box = document.querySelector<HTMLElement>('[data-induction-box]');
  if (box === null) throw new Error('no box');
  return {
    top: Number.parseFloat(box.style.top),
    left: Number.parseFloat(box.style.left),
    width: Number.parseFloat(box.style.width),
    height: Number.parseFloat(box.style.height),
  };
}

function cardTop(): number {
  const card = document.querySelector<HTMLElement>('[data-induction-card]');
  if (card === null) throw new Error('no card');
  return Number.parseFloat(card.style.top);
}

describe('the box', () => {
  it('draws around the live control, 7px out (5px gap plus a 2px border)', async () => {
    control('pipeline-stage-row', { top: 120, left: 16, width: 300, height: 44 });
    await mount({ step: 'stages' });
    expect(boxStyle()).toEqual({ top: 113, left: 9, width: 314, height: 58 });
  });

  it('follows the control when it moves, read again on scroll of <main>', async () => {
    const main = document.createElement('main');
    document.body.appendChild(main);
    const c = control('pipeline-stage-row', { top: 120, left: 16, width: 300, height: 44 }, main);
    await mount({ step: 'stages' });
    c.move({ top: 60, left: 16, width: 300, height: 44 });
    await act(async () => {
      main.dispatchEvent(new Event('scroll'));
    });
    await frame();
    expect(boxStyle().top).toBe(53);
  });

  it('follows the control on resize', async () => {
    const c = control('pipeline-stage-row', { top: 120, left: 16, width: 300, height: 44 });
    await mount({ step: 'stages' });
    c.move({ top: 120, left: 40, width: 200, height: 44 });
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
    });
    await frame();
    expect(boxStyle()).toEqual({ top: 113, left: 33, width: 214, height: 58 });
  });

  it('never dims: no backdrop, and the box takes no pointer', async () => {
    control('pipeline-stage-row', { top: 120, left: 16, width: 300, height: 44 });
    await mount({ step: 'stages' });
    const layer = document.querySelector('[data-induction-layer]')!;
    expect(layer.innerHTML).not.toMatch(/bg-black|backdrop|inset-0/);
    expect(document.querySelector('[data-induction-box]')!.className).toContain(
      'pointer-events-none',
    );
  });
});

describe('the card on a phone', () => {
  it('docks at the bottom, above the tab bar, for a control up top', async () => {
    control('pipeline-stage-row', { top: 120, left: 16, width: 300, height: 44 });
    await mount({ step: 'stages' });
    expect(cardTop()).toBeGreaterThan(844 / 2);
    expect(document.body.textContent).toContain('Step 2 of 8');
    expect(document.body.textContent).toContain('Every post lives in one of these.');
  });

  it('docks at the top for a control in the lower half', async () => {
    control('chat-mic', { top: 780, left: 330, width: 44, height: 44 });
    await mount(
      { step: 'chat_mic', postId: 'p1', clientInvited: true },
      '/chat?channel=group__ws-1__g1',
    );
    expect(cardTop()).toBeLessThan(844 / 2);
  });
});

describe('the card on a laptop', () => {
  beforeEach(() => {
    media.laptop = true;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  });

  it('sits below a control near the top', async () => {
    control('pipeline-stage-row', { top: 100, left: 300, width: 400, height: 44 });
    await mount({ step: 'stages' });
    expect(cardTop()).toBeGreaterThanOrEqual(100 + 44 + 7);
  });

  it('sits beside a control near the bottom', async () => {
    control('assets-add', { top: 720, left: 1200, width: 44, height: 44 });
    await mount({ step: 'assets', postId: 'p1', clientInvited: true }, '/assets');
    const card = document.querySelector<HTMLElement>('[data-induction-card]')!;
    expect(Number.parseFloat(card.style.left) + 320).toBeLessThanOrEqual(1200 - 7);
  });
});

describe('gates and sheets', () => {
  it('gives the first post gate no Next and no Later', async () => {
    control('pipeline-create', { top: 120, left: 300, width: 44, height: 44 });
    await mount({ step: 'first_post' });
    const card = document.querySelector('[data-induction-card]')!;
    expect(card.textContent).toContain('Send your first post for review');
    expect(card.querySelectorAll('button')).toHaveLength(0);
  });

  it('shows a strip under the sheet title, not a card, inside an open sheet', async () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.getBoundingClientRect = () =>
      ({ top: 300, left: 0, width: 390, height: 544, right: 390, bottom: 844 }) as DOMRect;
    const title = document.createElement('h2');
    title.getBoundingClientRect = () =>
      ({ top: 327, left: 18, width: 80, height: 20, right: 98, bottom: 347 }) as DOMRect;
    dialog.appendChild(title);
    document.body.appendChild(dialog);
    control('post-sheet-primary', { top: 780, left: 250, width: 120, height: 44 }, dialog);
    await mount({ step: 'first_post' });
    expect(document.querySelector('[data-induction-card]')).toBeNull();
    const strip = document.querySelector<HTMLElement>('[data-induction-strip]')!;
    expect(Number.parseFloat(strip.style.top)).toBe(349);
    expect(strip.textContent).toContain('Send your first post for review');
    expect(boxStyle().top).toBe(773);
  });
});

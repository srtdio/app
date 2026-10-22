// @vitest-environment jsdom
// The bar's compact mode with two current shared plans, measured for real:
// jsdom has no layout, so element widths come from a fake per measuring copy
// and per title word. Both plan items stay; other items drop their words
// first, then the plan titles drop whole trailing words, widest title first.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StatusTickerBar } from '@/components/chat/StatusTicker';
import { TITLE_ELLIPSIS, statusBar, type PlanSummary } from '@/lib/chat/status-bar';

const NO_MARKS = { commitments: 0, decisions: 0, pending: 0, p1: 0 };

/** Fake widths: the full copy, the compact copy, the ellipsis, each title word. */
const WIDTH = { full: 500, compact: 0, ellipsis: 6, area: 300 };

function fakeWidth(el: HTMLElement): number {
  const measure = el.getAttribute('data-status-measure');
  if (measure === '') return WIDTH.full;
  if (measure === 'compact') return WIDTH.compact;
  if (measure === 'ellipsis') return WIDTH.ellipsis;
  if (el.hasAttribute('data-title-word')) return 10 * (el.textContent ?? '').length;
  return 0;
}

const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return fakeWidth(this);
    },
  });
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get(this: Element) {
      return this.hasAttribute('data-status-items') ? WIDTH.area : 0;
    },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  if (offsetWidth !== undefined) {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth);
  }
  if (clientWidth !== undefined)
    Object.defineProperty(Element.prototype, 'clientWidth', clientWidth);
});

function plan(id: string, title: string): PlanSummary {
  return { id, title, approved: 1, total: 4, changes: 0 };
}

function render(plans: PlanSummary[]): void {
  const bar = statusBar({ plans, posts: 3, briefs: 2, marks: NO_MARKS, side: 'agency' });
  act(() => root.render(<StatusTickerBar bar={bar} />));
}

/** The painted (not measuring) item leads and keys. */
function painted(): { keys: string[]; leads: string[]; text: string } {
  const items = [...host.querySelectorAll<HTMLElement>('[data-status-items] > [data-status-item]')];
  return {
    keys: items.map((el) => el.getAttribute('data-status-item') ?? ''),
    leads: items
      .filter((el) => el.getAttribute('data-status-item') === 'plan')
      .map((el) => el.querySelector('span')?.textContent ?? ''),
    text: items.map((el) => el.textContent ?? '').join('|'),
  };
}

describe('compact with two current shared plans', () => {
  it('the compact row fits: both plan items keep their whole titles, words drop elsewhere', () => {
    WIDTH.compact = 280;
    render([plan('a', 'Week ahead plan'), plan('b', 'Festive fortnight')]);
    const ticker = host.querySelector('[data-loops-strip="open"]');
    expect(ticker?.getAttribute('data-status-ticker')).toBe('compact');
    const view = painted();
    expect(view.keys).toEqual(['plan', 'plan', 'posts', 'briefs']);
    expect(view.leads).toEqual(['Week ahead plan', 'Festive fortnight']);
    expect(
      host.querySelectorAll('[data-status-items] > [data-status-item] [data-status-word]'),
    ).toHaveLength(0);
  });

  it('still over: titles drop whole trailing words, widest first, both items stay', () => {
    // 100 over. "Festive fortnight" (70 + 100) drops " fortnight" first, then
    // "Week ahead plan" (40 + 60 + 50) drops " plan".
    WIDTH.compact = 400;
    render([plan('a', 'Week ahead plan'), plan('b', 'Festive fortnight')]);
    const view = painted();
    expect(view.keys).toEqual(['plan', 'plan', 'posts', 'briefs']);
    expect(view.leads).toEqual([`Week ahead${TITLE_ELLIPSIS}`, `Festive${TITLE_ELLIPSIS}`]);
    // The screen reader name keeps the whole title.
    const first = host.querySelector('[data-status-items] > [data-status-item="plan"]');
    expect(first?.getAttribute('aria-label')).toBe('Week ahead plan 1 of 4 approved');
  });

  it('three plans compact: two plan items, the +K hidden like every compact +K', () => {
    WIDTH.compact = 280;
    render([plan('a', 'Week ahead'), plan('b', 'Festive'), plan('c', 'Later')]);
    const view = painted();
    expect(view.keys).toEqual(['plan', 'plan', 'posts', 'briefs']);
    expect(
      host.querySelectorAll('[data-status-items] > [data-status-item] [data-status-more]'),
    ).toHaveLength(0);
  });

  it('one plan compact keeps "Plan" as today', () => {
    WIDTH.compact = 280;
    render([plan('a', 'Week ahead plan')]);
    expect(painted().leads).toEqual(['Plan']);
  });
});

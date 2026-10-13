// Visual checks for an open chat thread. The #432 iPhone bug was visual (the
// composer row painted over the thread area), so these read layout boxes and
// hit-testing, not just DOM counts.

import type { Page } from '@playwright/test';

export interface StepReport {
  step: string;
  /** C1: thread scroll list (or opening skeleton) height in CSS px. */
  threadHeight: number;
  /** C2: what sits under the screen centre. */
  centre: 'message' | 'skeleton' | 'thread' | 'composer' | 'other';
  centreDetail: string;
  /** C3: composer forms on screen, and the first one's box. */
  composerCount: number;
  composerTop: number;
  composerBottom: number;
  viewportHeight: number;
  failures: string[];
}

interface Probe {
  threadHeight: number;
  centre: StepReport['centre'];
  centreDetail: string;
  composerCount: number;
  composerTop: number;
  composerBottom: number;
  viewportHeight: number;
}

async function probe(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    // The thread's own scroll list: the scrollable <ul> holding the message rows.
    function threadList(): Element | null {
      const lists = [...document.querySelectorAll('ul')].filter((ul) => {
        const overflow = getComputedStyle(ul).overflowY;
        return (
          (overflow === 'auto' || overflow === 'scroll') &&
          ul.querySelector('[data-msg-id], [data-thread-spacer]') !== null
        );
      });
      return lists[0] ?? null;
    }
    const list = threadList();
    const skeleton = document.querySelector('ul[aria-label="Loading messages"]');
    const listHeight = list?.getBoundingClientRect().height ?? 0;
    const skeletonHeight = skeleton?.getBoundingClientRect().height ?? 0;
    const x = window.innerWidth / 2;
    const y = window.innerHeight / 2;
    const hit = document.elementFromPoint(x, y);
    let centre: Probe['centre'] = 'other';
    if (hit?.closest('form')?.querySelector('textarea')) centre = 'composer';
    else if (hit?.closest('[data-msg-id]')) centre = 'message';
    else if (hit?.closest('ul[aria-label="Loading messages"], [data-thread-opening]'))
      centre = 'skeleton';
    else if (list !== null && hit !== null && list.contains(hit)) centre = 'thread';
    const composers = [...document.querySelectorAll('form')].filter((form) => {
      if (form.querySelector('textarea') === null) return false;
      const box = form.getBoundingClientRect();
      // Any laid-out copy counts, on screen or below the fold.
      return box.height > 0;
    });
    const first = composers[0]?.getBoundingClientRect();
    return {
      threadHeight: Math.max(listHeight, skeletonHeight),
      centre,
      centreDetail: hit
        ? `${hit.tagName.toLowerCase()}.${String(hit.className).slice(0, 60)}`
        : 'none',
      composerCount: composers.length,
      composerTop: first?.top ?? -1,
      composerBottom: first?.bottom ?? -1,
      viewportHeight: window.innerHeight,
    };
  });
}

export async function checkStep(
  page: Page,
  step: string,
  options: { allowSkeleton: boolean; requireComposer: boolean },
): Promise<StepReport> {
  const p = await probe(page);
  const failures: string[] = [];
  if (p.threadHeight <= 200) failures.push(`C1 thread height ${p.threadHeight}px <= 200`);
  const okCentre = options.allowSkeleton
    ? ['message', 'skeleton', 'thread'].includes(p.centre)
    : ['message', 'thread'].includes(p.centre);
  if (!okCentre) failures.push(`C2 screen centre is ${p.centre} (${p.centreDetail})`);
  if (options.requireComposer || p.composerCount > 0) {
    if (p.composerCount !== 1) failures.push(`C3 ${p.composerCount} composers rendered`);
    else if (p.composerBottom < p.viewportHeight - 2 || p.composerTop < p.viewportHeight * 0.6) {
      failures.push(`C3 composer box ${p.composerTop}..${p.composerBottom} is not at the bottom`);
    }
  }
  return { step, ...p, failures };
}

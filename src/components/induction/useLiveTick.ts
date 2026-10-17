// Re-render the guide whenever the boxed control could have moved. Every frame
// it reads the control's rect (and the open sheet's) and re-renders only when
// one changed, which also covers what fires no event: a sheet sliding in, the
// iOS keyboard opening, an error line appearing under a field. Resize, any
// scroll, the visual viewport and DOM changes outside the guide re-render at
// once. The guide then reads every rect again in render; the last-seen value
// here only decides whether to re-render.
//
// It also says whether the control is still moving: a new control, or one
// whose rect changed, counts as moving until it has held still for SETTLE_MS,
// so the guide shows only its bar while a sheet slides in.

import { useEffect, useRef, useState } from 'react';
import { inLayer, topDialog } from './guide-dom';

export const SETTLE_MS = 120;

function signature(el: HTMLElement | undefined): string {
  const parts: number[] = [];
  if (el !== undefined) {
    const r = el.getBoundingClientRect();
    parts.push(r.top, r.left, r.width, r.height);
  }
  const dialog = topDialog();
  if (dialog.open) {
    const d = dialog.el.getBoundingClientRect();
    parts.push(d.top, d.left, d.width, d.height);
  }
  parts.push(window.innerWidth, window.innerHeight);
  // 0.1px: a sheet's easing tail moves well under half a pixel per frame, and a
  // coarser reading would call it still while it creeps the last pixels in.
  return parts.map((n) => Math.round(n * 10) / 10).join(',');
}

/**
 * Returns true while the control is new or moving. The frame loop runs only
 * until the control has held still for SETTLE_MS; resize, scroll, the visual
 * viewport and DOM changes start it again.
 */
export function useLiveTick(el: HTMLElement | undefined): boolean {
  const [, setTick] = useState(0);
  const changedAt = useRef({ el: undefined as HTMLElement | undefined, at: 0 });
  if (changedAt.current.el !== el) changedAt.current = { el, at: performance.now() };

  useEffect(() => {
    let raf = 0;
    let settle = 0;
    let last = signature(el);
    const bump = (): void => setTick((t) => t + 1);
    // Re-render once the control has held still for SETTLE_MS. A timer can
    // land early (WebKit's 1 ms clock), so re-arm until the render will read
    // "not moving".
    const settleCheck = (): void => {
      const elapsed = performance.now() - changedAt.current.at;
      if (elapsed < SETTLE_MS) settle = window.setTimeout(settleCheck, SETTLE_MS - elapsed + 2);
      else bump();
    };
    const moved = (): void => {
      changedAt.current = { el, at: performance.now() };
      window.clearTimeout(settle);
      settle = window.setTimeout(settleCheck, SETTLE_MS);
      bump();
    };
    const frame = (): void => {
      raf = 0;
      const now = signature(el);
      if (now !== last) {
        last = now;
        moved();
      }
      if (performance.now() - changedAt.current.at < SETTLE_MS * 2) {
        raf = requestAnimationFrame(frame);
      }
    };
    const wake = (): void => {
      changedAt.current = { el, at: Math.max(changedAt.current.at, performance.now() - SETTLE_MS) };
      if (raf === 0) raf = requestAnimationFrame(frame);
    };
    const poke = (): void => {
      bump();
      wake();
    };
    raf = requestAnimationFrame(frame);
    settle = window.setTimeout(settleCheck, SETTLE_MS);
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => !inLayer(record.target))) poke();
    });
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true });
    const viewport = window.visualViewport;
    window.addEventListener('resize', poke);
    document.addEventListener('scroll', poke, true);
    viewport?.addEventListener('resize', poke);
    viewport?.addEventListener('scroll', poke);
    // A transition or animation ending is the moment a sliding sheet lands.
    const landed = (event: Event): void => {
      if (event.target instanceof Node && !inLayer(event.target)) poke();
    };
    document.addEventListener('transitionend', landed, true);
    document.addEventListener('animationend', landed, true);
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      window.clearTimeout(settle);
      mutations.disconnect();
      window.removeEventListener('resize', poke);
      document.removeEventListener('scroll', poke, true);
      viewport?.removeEventListener('resize', poke);
      viewport?.removeEventListener('scroll', poke);
      document.removeEventListener('transitionend', landed, true);
      document.removeEventListener('animationend', landed, true);
    };
  }, [el]);

  return performance.now() - changedAt.current.at < SETTLE_MS;
}

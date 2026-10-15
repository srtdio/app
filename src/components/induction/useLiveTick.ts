// Re-render the guide whenever the boxed control could have moved: window
// resize, any scroll (the <main> scroller, a sheet body), a ResizeObserver on
// the control, DOM changes outside the guide, and every frame while a CSS
// transition or animation runs (a sheet sliding in). The guide then reads the
// control's rect again in render; nothing positional is kept here.

import { useEffect, useState } from 'react';
import { inLayer } from './guide-dom';

/** How long frames keep coming after a transition starts (the slowest sheet is 320ms). */
const MOTION_WINDOW_MS = 700;

export function useLiveTick(el: HTMLElement | undefined): void {
  const [, setTick] = useState(0);

  useEffect(() => {
    let raf = 0;
    let movingUntil = 0;
    const frame = (): void => {
      raf = 0;
      setTick((t) => t + 1);
      if (performance.now() < movingUntil) raf = requestAnimationFrame(frame);
    };
    const bump = (): void => {
      if (raf === 0) raf = requestAnimationFrame(frame);
    };
    const motion = (event: Event): void => {
      if (event.target instanceof Node && inLayer(event.target)) return;
      movingUntil = performance.now() + MOTION_WINDOW_MS;
      bump();
    };
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => !inLayer(record.target))) bump();
    });
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true });
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(bump);
    if (el !== undefined) sizes?.observe(el);
    window.addEventListener('resize', bump);
    document.addEventListener('scroll', bump, true);
    document.addEventListener('transitionrun', motion, true);
    document.addEventListener('animationstart', motion, true);
    document.addEventListener('transitionend', bump, true);
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      mutations.disconnect();
      sizes?.disconnect();
      window.removeEventListener('resize', bump);
      document.removeEventListener('scroll', bump, true);
      document.removeEventListener('transitionrun', motion, true);
      document.removeEventListener('animationstart', motion, true);
      document.removeEventListener('transitionend', bump, true);
    };
  }, [el]);
}

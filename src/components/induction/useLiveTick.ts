// Re-render the guide whenever the boxed control could have moved. Every frame
// it reads the control's rect (and the open sheet's) and re-renders only when
// one changed, which also covers what fires no event: a sheet sliding in, the
// iOS keyboard opening, an error line appearing under a field. Resize, any
// scroll, the visual viewport and DOM changes outside the guide re-render at
// once. The guide then reads every rect again in render; the last-seen value
// here only decides whether to re-render.

import { useEffect, useState } from 'react';
import { inLayer, topDialog } from './guide-dom';

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
  return parts.map((n) => Math.round(n * 2) / 2).join(',');
}

export function useLiveTick(el: HTMLElement | undefined): void {
  const [, setTick] = useState(0);

  useEffect(() => {
    let raf = 0;
    let last = signature(el);
    const bump = (): void => setTick((t) => t + 1);
    const frame = (): void => {
      const now = signature(el);
      if (now !== last) {
        last = now;
        bump();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const mutations = new MutationObserver((records) => {
      if (records.some((record) => !inLayer(record.target))) bump();
    });
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true });
    const viewport = window.visualViewport;
    window.addEventListener('resize', bump);
    document.addEventListener('scroll', bump, true);
    viewport?.addEventListener('resize', bump);
    viewport?.addEventListener('scroll', bump);
    return () => {
      cancelAnimationFrame(raf);
      mutations.disconnect();
      window.removeEventListener('resize', bump);
      document.removeEventListener('scroll', bump, true);
      viewport?.removeEventListener('resize', bump);
      viewport?.removeEventListener('scroll', bump);
    };
  }, [el]);
}

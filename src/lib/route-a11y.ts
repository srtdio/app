// Route changes for screen readers and the keyboard, run once in AppLayout:
// the tab title reads "{Screen} · Sorted" and, on a navigation (never on the
// first load), focus moves to the screen's h1 (tabIndex -1, PageHead) so a
// screen reader starts at the new page's title instead of the old nav link.
// The chat's "(N) " unread prefix on the title is kept as it is.

import { useEffect, useRef } from 'react';
import { modalLayerCount, isTextField } from '@/lib/modal-focus';

const APP_NAME = 'Sorted';

/** Screen name per route prefix, most specific first. */
const SCREENS: readonly (readonly [RegExp, string])[] = [
  [/^\/pipeline\b/, 'Pipeline'],
  [/^\/(posts|p)\//, 'Post'],
  [/^\/briefs\/?$/, 'Briefs'],
  [/^\/(briefs|b)\//, 'Brief'],
  [/^\/chat\b/, 'Chat'],
  [/^\/(notifications|activity)\b/, 'Activity'],
  [/^\/(plan|plans)\b/, 'Plan'],
  [/^\/assets\b/, 'Assets'],
  [/^\/settings\b/, 'Settings'],
  [/^\/help\b/, 'Help'],
  [/^\/deleted\b/, 'Recently deleted'],
];

/** The screen a path shows, or null for a route with no screen name. Pure. */
export function screenNameFor(pathname: string): string | null {
  for (const [pattern, name] of SCREENS) {
    if (pattern.test(pathname)) return name;
  }
  return null;
}

const UNREAD_PREFIX = /^\(\d+\) /;

/** "{Screen} · Sorted", keeping a leading "(N) " unread count from `current`. Pure. */
export function routeTitle(screen: string | null, current: string): string {
  const prefix = UNREAD_PREFIX.exec(current)?.[0] ?? '';
  return `${prefix}${screen === null ? APP_NAME : `${screen} · ${APP_NAME}`}`;
}

/** The screen's h1 that takes focus on navigation (tabIndex -1), outside any dialog. */
export function routeHeading(doc: Document = document): HTMLElement | null {
  const all = Array.from(doc.querySelectorAll<HTMLElement>('main h1[tabindex="-1"]'));
  return all.find((el) => el.closest('[role="dialog"]') === null) ?? null;
}

/** How many frames to look for the new screen's h1 (a lazy page paints a little later). */
const HEADING_FRAMES = 30;

/**
 * Title on every route; focus to the h1 on a route change after the first. Never
 * steals focus from an open modal or a text field the new screen focused itself.
 */
export function useRouteA11y(pathname: string): void {
  const first = useRef(true);
  useEffect(() => {
    document.title = routeTitle(screenNameFor(pathname), document.title);
    if (first.current) {
      first.current = false;
      return;
    }
    let frames = 0;
    let raf = 0;
    const tryFocus = (): void => {
      if (modalLayerCount() > 0) return;
      const active = document.activeElement;
      if (active !== null && isTextField(active)) return;
      const heading = routeHeading();
      if (heading !== null) {
        heading.focus({ preventScroll: true });
        return;
      }
      frames += 1;
      if (frames < HEADING_FRAMES) raf = requestAnimationFrame(tryFocus);
    };
    raf = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(raf);
  }, [pathname]);
}

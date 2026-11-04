// The colour a mobile browser's own top bar should take on a Sorted screen: the
// solid surface at the very top of that screen, as a token name (never a hex).
//
// - Android Chrome, Samsung Internet and installed home-screen apps read
//   <meta name="theme-color">; src/lib/theme.ts writes the computed value of
//   this token there on theme change and on every shell route change.
// - iOS Safari 26 and every WebKit iOS or in-app browser ignore theme-color
//   (installed web apps aside) and sample a solid fixed or sticky element at
//   the top edge, else the canvas. The pinned Topbar covers the status bar
//   strip in page mode; a phone chat thread adds its own strip
//   (MessageThread.tsx, ThreadTopStrip).

export type BarTint = 'panel' | 'bg';

export interface BarTintInput {
  pathname: string;
  search: string | URLSearchParams;
  /** useIsLaptop(): 768px and up, touch tablets included. */
  isLaptop: boolean;
  /** A chat thread is open (/chat?channel=...). */
  threadOpen: boolean;
}

// Post detail (/posts/:id, /p/:ref) and Brief detail (/briefs/:id, /b/:ref);
// the same rule as isDetailRoute in src/components/shell/AppLayout.tsx.
const DETAIL_ROUTE = /^\/(posts|p|briefs|b)\/[^/]+\/?$/;

function threadIn(pathname: string, search: string | URLSearchParams): boolean {
  if (pathname.startsWith('/chat/')) return true;
  if (pathname !== '/chat') return false;
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const channel = params.get('channel');
  return channel !== null && channel !== '';
}

/**
 * Laptop (and touch tablet, 768px and up): the Topbar is on top everywhere,
 * 'panel'. Phone: a chat thread's header is 'panel'; a Post or Brief detail
 * page drops the Topbar and its own header has no fill, so the top is the
 * canvas, 'bg'; every other screen has the Topbar, 'panel'.
 */
export function barTintFor({ pathname, search, isLaptop, threadOpen }: BarTintInput): BarTint {
  if (isLaptop) return 'panel';
  if (threadOpen || threadIn(pathname, search)) return 'panel';
  if (DETAIL_ROUTE.test(pathname)) return 'bg';
  return 'panel';
}

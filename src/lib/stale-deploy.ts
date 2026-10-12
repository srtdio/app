import { logger } from '@/lib/logger';

// Stale-deploy guard. A tab opened before a deploy can ask for a hashed CSS
// file that no longer exists; the Pages SPA fallback answers with index.html
// (200), the stylesheet never applies and the app renders as bare HTML. Before
// the first render we check that the --bg token from src/index.css resolved
// and, if not, reload once with a cache-busting "_r" param so the fresh
// index.html (with the current asset hashes) is fetched.
//
// Loop safety: a reload only happens when neither the sessionStorage guard nor
// the "_r" param is present. Either one marks "already reloaded", so a second
// unstyled load renders as-is (with one warning) even when storage throws.

export const STALE_RELOAD_KEY = 'sorted:stale-reload';
export const RELOAD_PARAM = '_r';
const STYLESHEET_WAIT_MS = 3000;

export interface StylesheetLink extends EventTarget {
  readonly sheet: CSSStyleSheet | null;
}

type GuardStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface StaleDeployDeps {
  stylesheet: StylesheetLink | null;
  isDocumentComplete: () => boolean;
  readBgToken: () => string;
  getHref: () => string;
  reload: (url: string) => void;
  replaceUrl: (url: string) => void;
  // A getter because touching window.sessionStorage itself can throw.
  storage: () => GuardStorage;
  now: () => number;
  timeoutMs?: number;
}

// Resolves once the stylesheet has loaded or failed, or after timeoutMs.
export function waitForStylesheet(
  link: StylesheetLink | null,
  isDocumentComplete: boolean,
  timeoutMs: number,
): Promise<void> {
  if (!link || link.sheet || isDocumentComplete) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      link.removeEventListener('load', done);
      link.removeEventListener('error', done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    link.addEventListener('load', done);
    link.addEventListener('error', done);
  });
}

function readGuard(deps: StaleDeployDeps): boolean {
  try {
    return deps.storage().getItem(STALE_RELOAD_KEY) !== null;
  } catch {
    return false;
  }
}

function writeGuard(deps: StaleDeployDeps, set: boolean): void {
  try {
    const storage = deps.storage();
    if (set) storage.setItem(STALE_RELOAD_KEY, '1');
    else storage.removeItem(STALE_RELOAD_KEY);
  } catch {
    // Storage unavailable: the "_r" param alone bounds the reload to one.
  }
}

// Returns true when the app should render, false when a reload was issued.
export async function runStaleDeployGuard(deps: StaleDeployDeps): Promise<boolean> {
  try {
    await waitForStylesheet(
      deps.stylesheet,
      deps.isDocumentComplete(),
      deps.timeoutMs ?? STYLESHEET_WAIT_MS,
    );
    const url = new URL(deps.getHref());
    const hasParam = url.searchParams.has(RELOAD_PARAM);

    if (deps.readBgToken().trim() !== '') {
      if (hasParam) {
        url.searchParams.delete(RELOAD_PARAM);
        deps.replaceUrl(url.toString());
      }
      writeGuard(deps, false);
      return true;
    }

    if (hasParam || readGuard(deps)) {
      logger.warn('stale_deploy_unstyled_after_reload', { path: url.pathname });
      return true;
    }

    writeGuard(deps, true);
    url.searchParams.set(RELOAD_PARAM, String(deps.now()));
    deps.reload(url.toString());
    return false;
  } catch {
    return true;
  }
}

export function browserStaleDeployDeps(): StaleDeployDeps {
  return {
    stylesheet: document.querySelector<HTMLLinkElement>('link[rel="stylesheet"][href*="/assets/"]'),
    isDocumentComplete: () => document.readyState === 'complete',
    readBgToken: () => getComputedStyle(document.documentElement).getPropertyValue('--bg'),
    getHref: () => window.location.href,
    reload: (url) => window.location.replace(url),
    replaceUrl: (url) => window.history.replaceState(window.history.state, '', url),
    storage: () => window.sessionStorage,
    now: () => Date.now(),
  };
}

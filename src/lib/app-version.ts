// Skew protection, client half. CI stamps each build with VITE_APP_VERSION
// (the commit sha) and writes the same value to /version.json. An open tab
// checks /version.json when it becomes visible, on window focus and every
// CHECK_INTERVAL_MS while visible (at most once per CHECK_THROTTLE_MS). When
// the deployed version differs from the running one the tab is stale, and the
// next in-app navigation in the signed-in shell becomes a full page load of
// the same URL, so the tab quietly moves to the new build at a moment the
// screen changes anyway. Old chunks stay served meanwhile
// (scripts/carry-assets.ts), and chunk-reload.ts / stale-deploy.ts remain the
// fallbacks.
//
// Never on the first render, never twice for one version (sessionStorage
// guard keyed by the target version; storage that throws means no reload),
// and never while a Back guard (src/lib/back-guard.ts) holds unsaved work.
// With VITE_APP_VERSION unset (local dev) the whole check is off.

import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { BACK_GUARD_STEP_KEY } from '@/lib/back-guard';
import { stepMarkerOf } from '@/lib/chat/use-history-step';

export const APP_VERSION_RELOAD_KEY = 'sorted:app-version-reload';
export const VERSION_URL = '/version.json';
/** At most one /version.json read per minute. */
export const CHECK_THROTTLE_MS = 60_000;
/** While visible, check every five minutes. */
export const CHECK_INTERVAL_MS = 5 * 60_000;
/** How long a check waits for /version.json before giving up. */
const CHECK_TIMEOUT_MS = 3000;

/** The running build's version, or '' when unset (the check is off). */
export function runningVersion(raw: unknown = import.meta.env.VITE_APP_VERSION): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/** The version in a /version.json body, or null when it is not one. */
export function parseVersion(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const version = (parsed as { version?: unknown }).version;
    return typeof version === 'string' && version.trim() !== '' ? version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * GET /version.json, bypassing the cache. XMLHttpRequest, not fetchWithTrace,
 * for the same reason as headStatus in chunk-reload.ts: it reads a static
 * file, not an API, so it carries no trace id, and on a stale deploy a
 * dynamic import of the wrapper could itself be the missing chunk. Resolves
 * null on a network error, a timeout, a non-200 status or a bad body.
 */
function fetchDeployedVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', VERSION_URL);
      xhr.timeout = CHECK_TIMEOUT_MS;
      xhr.setRequestHeader('Cache-Control', 'no-store');
      xhr.onload = () => resolve(xhr.status === 200 ? parseVersion(xhr.responseText) : null);
      xhr.onerror = () => resolve(null);
      xhr.ontimeout = () => resolve(null);
      xhr.onabort = () => resolve(null);
      xhr.send();
    } catch {
      resolve(null);
    }
  });
}

export interface VersionCheckerDeps {
  /** The running version; '' turns every check off. */
  current: string;
  /** The deployed version, or null when it could not be read. */
  fetchVersion: () => Promise<string | null>;
  now: () => number;
}

export interface VersionChecker {
  /** Read the deployed version unless one was read in the last CHECK_THROTTLE_MS. */
  check: () => Promise<void>;
  /** The deployed version this tab is behind, or null while current. */
  staleVersion: () => string | null;
}

export function createVersionChecker(deps: VersionCheckerDeps): VersionChecker {
  let lastCheck = Number.NEGATIVE_INFINITY;
  let stale: string | null = null;
  return {
    check: async () => {
      if (deps.current === '') return;
      const now = deps.now();
      if (now - lastCheck < CHECK_THROTTLE_MS) return;
      lastCheck = now;
      let deployed: string | null;
      try {
        deployed = await deps.fetchVersion();
      } catch {
        return;
      }
      // Unreadable: keep what we knew. Back on our version (a rollback): current again.
      if (deployed === null) return;
      stale = deployed === deps.current ? null : deployed;
    },
    staleVersion: () => (deps.current === '' ? null : stale),
  };
}

/** The slice of window the triggers listen on (the real window, or a test fake). */
export interface VersionCheckTriggers {
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  visibilityTarget: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  isVisible: () => boolean;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
}

/** Check on becoming visible, on focus and every CHECK_INTERVAL_MS while visible. Returns a stop. */
export function startVersionChecks(
  checker: Pick<VersionChecker, 'check'>,
  triggers: VersionCheckTriggers,
): () => void {
  const run = (): void => {
    void checker.check();
  };
  const onVisibility = (): void => {
    if (triggers.isVisible()) run();
  };
  triggers.visibilityTarget.addEventListener('visibilitychange', onVisibility);
  triggers.target.addEventListener('focus', run);
  const id = triggers.setInterval(onVisibility, CHECK_INTERVAL_MS);
  return () => {
    triggers.visibilityTarget.removeEventListener('visibilitychange', onVisibility);
    triggers.target.removeEventListener('focus', run);
    triggers.clearInterval(id);
  };
}

/** Where a navigation landed: React Router's location at that render. */
export interface RouteTarget {
  pathname: string;
  search: string;
  hash: string;
}

export interface NavigateReloadDeps {
  staleVersion: () => string | null;
  /** A getter because touching window.sessionStorage itself can throw. */
  storage: () => Pick<Storage, 'getItem' | 'setItem'>;
  /** True while a Back guard holds unsaved work. */
  guardActive: () => boolean;
  assign: (url: string) => void;
}

/**
 * Per shell mount: call on every render's location. Returns true when it
 * issued the full page load. The first call only records where the tab is.
 */
export function createNavigateReloader(
  deps: NavigateReloadDeps,
): (target: RouteTarget) => boolean {
  let last: string | null = null;
  return (target) => {
    const url = `${target.pathname}${target.search}${target.hash}`;
    const previous = last;
    last = url;
    if (previous === null || previous === url) return false;
    const version = deps.staleVersion();
    if (version === null) return false;
    if (deps.guardActive()) return false;
    try {
      const storage = deps.storage();
      if (storage.getItem(APP_VERSION_RELOAD_KEY) === version) return false;
      storage.setItem(APP_VERSION_RELOAD_KEY, version);
    } catch {
      // Storage unavailable: no guard means no reload.
      return false;
    }
    deps.assign(url);
    return true;
  };
}

/** True while the current history entry is a Back guard's step. */
function backGuardActive(): boolean {
  return stepMarkerOf(window.history.state, BACK_GUARD_STEP_KEY) !== null;
}

let browserChecker: VersionChecker | null = null;

function sharedChecker(): VersionChecker {
  browserChecker ??= createVersionChecker({
    current: runningVersion(),
    fetchVersion: fetchDeployedVersion,
    now: () => Date.now(),
  });
  return browserChecker;
}

/**
 * The signed-in shell: on a route change while a newer build is deployed,
 * load the same URL fresh (pathname, search and hash from the router, so
 * ?comment= and other params survive before any page strips them).
 */
export function useReloadOnNavigateWhenStale(): void {
  const { pathname, search, hash } = useLocation();
  const reloaderRef = useRef<((target: RouteTarget) => boolean) | null>(null);

  useEffect(() => {
    if (runningVersion() === '') return;
    return startVersionChecks(sharedChecker(), {
      target: window,
      visibilityTarget: document,
      isVisible: () => document.visibilityState === 'visible',
      setInterval: (fn, ms) => window.setInterval(fn, ms),
      clearInterval: (id) => window.clearInterval(id as number),
    });
  }, []);

  useEffect(() => {
    if (runningVersion() === '') return;
    reloaderRef.current ??= createNavigateReloader({
      staleVersion: () => sharedChecker().staleVersion(),
      storage: () => window.sessionStorage,
      guardActive: backGuardActive,
      assign: (url) => window.location.assign(url),
    });
    reloaderRef.current({ pathname, search, hash });
  }, [pathname, search, hash]);
}

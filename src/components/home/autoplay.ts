// Autoplay decision shared by every homepage video. Pure so it can be tested
// without a browser.

export interface AutoplayEnv {
  reducedMotion: boolean;
  saveData: boolean;
  effectiveType: string | undefined;
}

const SLOW_CONNECTIONS = new Set(['slow-2g', '2g', '3g']);

/** False means: show the poster with a play button and wait for a tap. */
export function shouldAutoplay(env: AutoplayEnv): boolean {
  if (env.reducedMotion || env.saveData) return false;
  return env.effectiveType === undefined || !SLOW_CONNECTIONS.has(env.effectiveType);
}

// Network Information API: Chromium only, absent from the DOM lib types.
interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

export function readAutoplayEnv(): AutoplayEnv {
  const nav: Navigator & { connection?: NetworkInformationLike } = navigator;
  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return {
    reducedMotion,
    saveData: nav.connection?.saveData === true,
    effectiveType: nav.connection?.effectiveType,
  };
}

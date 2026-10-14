// Autoplay decision shared by every homepage video. Pure so it can be tested
// without a browser.

export interface AutoplayEnv {
  reducedMotion: boolean;
}

/**
 * Every clip autoplays like an animation. The one exception is the OS-level
 * "reduce motion" accessibility setting: those viewers see the still poster.
 */
export function shouldAutoplay(env: AutoplayEnv): boolean {
  return !env.reducedMotion;
}

export function readAutoplayEnv(): AutoplayEnv {
  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return { reducedMotion };
}

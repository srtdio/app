// Motion on or off. Off when the OS asks for reduced motion, or when the page
// was opened with ?motion=0 (remembered for the tab in sessionStorage, so the
// flag survives in-app navigation). ?motion=1 clears it. Off means every move
// lands on its end state at once. Read synchronously, never awaited, never
// throws: storage can be blocked in private windows.
const KEY = 'sorted.motion';
const REDUCE = '(prefers-reduced-motion: reduce)';

let urlChecked = false;

function readUrlFlag(): void {
  if (urlChecked) return;
  urlChecked = true;
  try {
    const flag = new URLSearchParams(window.location.search).get('motion');
    if (flag === '0') window.sessionStorage.setItem(KEY, '0');
    if (flag === '1') window.sessionStorage.removeItem(KEY);
  } catch {
    // No storage: the flag still holds for this page via the URL read below.
  }
}

function urlOff(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get('motion') === '0') return true;
  } catch {
    // ignore
  }
  try {
    return window.sessionStorage.getItem(KEY) === '0';
  } catch {
    return false;
  }
}

function reduceOn(): boolean {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia(REDUCE).matches;
  } catch {
    return false;
  }
}

/** True when moves must be instant (Reduce Motion or ?motion=0). */
export function motionOff(): boolean {
  if (typeof window === 'undefined') return true;
  readUrlFlag();
  return urlOff() || reduceOn();
}

/**
 * Mirror the preference on <html data-motion="off"> so the CSS moves in
 * motion.css collapse too. Called once at boot (main.tsx) and again when the
 * OS setting flips. Returns a cleanup.
 */
export function installMotionPreference(onChange?: (off: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const apply = (): void => {
    const off = motionOff();
    try {
      if (off) document.documentElement.dataset.motion = 'off';
      else delete document.documentElement.dataset.motion;
    } catch {
      // ignore
    }
    onChange?.(off);
  };
  apply();
  try {
    const query = window.matchMedia(REDUCE);
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  } catch {
    return () => undefined;
  }
}

/** Test seam: forget the cached URL read. */
export function resetMotionPreferenceForTests(): void {
  urlChecked = false;
}

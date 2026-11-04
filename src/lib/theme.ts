import type { BarTint } from '@/lib/bar-tint';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'sorted-theme';

/**
 * Light unless the person picked dark themselves (Settings or the theme toggle).
 * The phone's own dark setting is not followed: everyone starts in light.
 */
export function getTheme(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

// The browser bar tint of the screen on show (src/lib/bar-tint.ts). 'bg' until
// the shell names one, so screens outside the shell (sign-in, onboarding, the
// homepage) keep the painted canvas exactly as before.
let currentTint: BarTint = 'bg';

/**
 * Mirror the current screen's top surface onto every theme-color meta, so the
 * Android Chrome, Samsung Internet and installed-app bar matches it in the
 * chosen theme. 'bg' reads the now-painted html canvas (var(--bg), or the
 * homepage's own white); 'panel' reads the --panel token. One getComputedStyle,
 * token-only, no listeners. Called on theme change (no argument: keeps the
 * screen's tint) and by the shell on route change (AppLayout, BarTintSync).
 */
export function syncThemeColorMeta(tint: BarTint = currentTint): void {
  currentTint = tint;
  const style = getComputedStyle(document.documentElement);
  const color = tint === 'panel' ? style.getPropertyValue('--panel').trim() : style.backgroundColor;
  if (!color) return;
  document.querySelectorAll('meta[name="theme-color"]').forEach((el) => {
    if (el.getAttribute('content') !== color) el.setAttribute('content', color);
  });
}

// index.html paints a dark canvas (html.pre-dark) before the stylesheet loads for
// people who chose dark; once the app owns the theme that hint is dropped.
function applyTheme(theme: Theme): void {
  document.documentElement.classList.remove('pre-dark');
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

function setTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
  syncThemeColorMeta();
}

// While html.theme-switching is on, src/lib/motion/motion.css turns every
// transition off, so a theme flip lands in one frame instead of each mv-tint
// and mv-press easing its colours separately (docs/motion.md). Two frames:
// the first paints the new theme, the second lets styles settle before
// transitions come back. No await: the flip and the meta write stay
// synchronous; only the class removal is deferred.
export const THEME_SWITCHING_CLASS = 'theme-switching';

let switchFrame = 0;

function holdTransitionsForTwoFrames(): void {
  const root = document.documentElement;
  root.classList.add(THEME_SWITCHING_CLASS);
  if (typeof requestAnimationFrame !== 'function') {
    root.classList.remove(THEME_SWITCHING_CLASS);
    return;
  }
  // A second toggle inside the two frames restarts the count.
  if (switchFrame) cancelAnimationFrame(switchFrame);
  switchFrame = requestAnimationFrame(() => {
    switchFrame = requestAnimationFrame(() => {
      switchFrame = 0;
      root.classList.remove(THEME_SWITCHING_CLASS);
    });
  });
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  holdTransitionsForTwoFrames();
  setTheme(next);
  return next;
}

export function initTheme(): void {
  applyTheme(getTheme());
  syncThemeColorMeta();
}

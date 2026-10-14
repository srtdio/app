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

// Read the now-painted html canvas (var(--bg), token-only) and mirror it onto
// every theme-color meta so the Safari toolbar tracks the chosen theme.
function syncThemeColorMeta(): void {
  const color = getComputedStyle(document.documentElement).backgroundColor;
  if (!color) return;
  document.querySelectorAll('meta[name="theme-color"]').forEach((el) => {
    el.setAttribute('content', color);
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

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

export function initTheme(): void {
  applyTheme(getTheme());
  syncThemeColorMeta();
}

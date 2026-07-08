export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'sorted-theme';

export function getTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') {
    return stored;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// A manual toggle can pin a theme against the OS setting, which the
// media-split <meta name="theme-color"> tags cannot follow. Read the now-painted
// html canvas (var(--bg), token-only) and mirror it onto every theme-color meta
// so the Safari toolbar tracks the pinned theme, not the system one.
function syncThemeColorMeta(): void {
  const color = getComputedStyle(document.documentElement).backgroundColor;
  if (!color) return;
  document.querySelectorAll('meta[name="theme-color"]').forEach((el) => {
    el.setAttribute('content', color);
  });
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
  document.documentElement.classList.toggle('dark', theme === 'dark');
  syncThemeColorMeta();
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

export function initTheme(): void {
  document.documentElement.classList.toggle('dark', getTheme() === 'dark');
}

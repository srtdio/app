import { useState } from 'react';
import { getTheme, toggleTheme, type Theme } from '@/lib/theme';

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setThemeState] = useState<Theme>(getTheme);
  function toggle(): void {
    setThemeState(toggleTheme());
  }
  return { theme, toggle };
}

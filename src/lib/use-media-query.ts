import { useEffect, useState } from 'react';

/**
 * Reactively track a CSS media query. Used where presentation must branch in JS
 * rather than CSS, e.g. a popover that becomes a bottom Sheet (which portals out
 * of the DOM and so cannot be hidden with a responsive utility class).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => window.matchMedia(query).matches);

  useEffect(() => {
    const list = window.matchMedia(query);
    function onChange(): void {
      setMatches(list.matches);
    }
    onChange();
    list.addEventListener('change', onChange);
    return () => {
      list.removeEventListener('change', onChange);
    };
  }, [query]);

  return matches;
}

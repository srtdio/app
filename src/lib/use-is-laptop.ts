import { useEffect, useState } from 'react';

// Tailwind md, the same width as LAPTOP_QUERY in use-media-query.ts. Kept here
// so a test that mocks use-media-query never breaks the ⋯ menu or decision bar.
const LAPTOP_MIN_WIDTH = '(min-width: 768px)';

function matches(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(LAPTOP_MIN_WIDTH).matches
    : false;
}

/**
 * Phone vs laptop, the one switch: true at a viewport width of 768px or more
 * (Tailwind md). ActionMenu (sheet vs popover) and the decision bar (bottom
 * bar vs header right) read it; nothing else decides the split on its own.
 * Without matchMedia (a bare test environment) it reads as phone.
 */
export function useIsLaptop(): boolean {
  const [isLaptop, setIsLaptop] = useState<boolean>(matches);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(LAPTOP_MIN_WIDTH);
    function onChange(): void {
      setIsLaptop(list.matches);
    }
    onChange();
    list.addEventListener('change', onChange);
    return () => {
      list.removeEventListener('change', onChange);
    };
  }, []);

  return isLaptop;
}

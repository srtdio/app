import { useEffect, useRef, useState } from 'react';

/**
 * Track whether an element is (or has been) scrolled into view. Used to defer
 * asset thumbnail presigning until a card is actually visible, so a long grid
 * never presigns every card up front. Once seen, `inView` latches true: a
 * thumbnail that has loaded should not be torn down when it scrolls away.
 */
export function useInView<T extends Element>(
  rootMargin = '200px',
): { ref: React.RefObject<T>; inView: boolean } {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (element === null || inView) return;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setInView(true);
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [inView, rootMargin]);

  return { ref, inView };
}

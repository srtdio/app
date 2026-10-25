import { useEffect, useState } from 'react';

/** The one phone vs laptop line: 768px wide and up is laptop (Tailwind md). */
export const LAPTOP_MIN_WIDTH_PX = 768;

// Width only, never pointer type: an iPad (portrait 768 to 834, landscape
// 1024 and up) is laptop on every surface, Chat included.
const LAPTOP_MIN_WIDTH = `(min-width: ${LAPTOP_MIN_WIDTH_PX}px)`;
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const COARSE_POINTER = '(pointer: coarse)';
const HOVER_POINTER = '(hover: hover) and (pointer: fine)';

function query(media: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(media).matches
    : false;
}

function useQuery(media: string): boolean {
  const [value, setValue] = useState<boolean>(() => query(media));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(media);
    function onChange(): void {
      setValue(list.matches);
    }
    onChange();
    list.addEventListener('change', onChange);
    return () => {
      list.removeEventListener('change', onChange);
    };
  }, [media]);

  return value;
}

/** Phone vs laptop read once, synchronously (event handlers, first-paint initializers). */
export function isLaptopNow(): boolean {
  return query(LAPTOP_MIN_WIDTH);
}

/**
 * Phone vs laptop, the one switch: true at a viewport width of 768px or more
 * (Tailwind md), iPad included. Every surface that branches phone vs laptop in
 * JS reads this; Tailwind md: classes stay for pure layout. Without matchMedia
 * (a bare test environment) it reads as phone.
 */
export function useIsLaptop(): boolean {
  return useQuery(LAPTOP_MIN_WIDTH);
}

/** The person asked for less motion (read once). */
export function prefersReducedMotion(): boolean {
  return query(REDUCED_MOTION);
}

/** The person asked for less motion (reactive). */
export function usePrefersReducedMotion(): boolean {
  return useQuery(REDUCED_MOTION);
}

/**
 * A touch screen is the primary pointer (read once). Input, not layout: decides
 * things like whether Enter sends or a field takes focus on open, never phone
 * vs laptop.
 */
export function isCoarsePointer(): boolean {
  return query(COARSE_POINTER);
}

/** A touch screen is the primary pointer (reactive). */
export function useCoarsePointer(): boolean {
  return useQuery(COARSE_POINTER);
}

/** A mouse or trackpad is the primary pointer (reactive): hover-only controls. */
export function useHoverPointer(): boolean {
  return useQuery(HOVER_POINTER);
}

/** The viewport size right now, for placing popovers inside it. */
export function viewportSize(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  return { width: window.innerWidth, height: window.innerHeight };
}

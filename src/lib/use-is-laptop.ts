import { LAPTOP_QUERY, useMediaQuery } from '@/lib/use-media-query';

/**
 * Phone vs laptop, the one switch: true at a viewport width of 768px or more
 * (Tailwind md). ActionMenu (sheet vs popover) and the decision bar (bottom
 * bar vs header right) read it; nothing else decides the split on its own.
 */
export function useIsLaptop(): boolean {
  return useMediaQuery(LAPTOP_QUERY);
}

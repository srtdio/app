// Chat-only glyphs not in the shared icon set (src/components/ui/icons.tsx is
// outside chat's scope). Same 24x24 stroke grammar as the shared icons.

import type { ReactElement } from 'react';

export interface ChatIconProps {
  className?: string;
  size?: number;
}

/** Hide: an eye with a slash. Non-destructive (the chat comes back on a new message). */
export function IconEyeOff({ className, size = 18 }: ChatIconProps): ReactElement {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.6 3.5" />
      <path d="M6.6 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

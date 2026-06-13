// Chat-local icon for the composer's attach affordance. icons.tsx has no
// paperclip and is a shared primitive; rather than widen it for one caller, the
// glyph lives here matching the same 24-viewbox, currentColor, 1.7-stroke style.

import type { ReactElement } from 'react';

interface IconProps {
  size?: number;
  className?: string;
}

export function IconPaperclip({ size = 18, className }: IconProps): ReactElement {
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
    >
      <path d="M20 11l-7.8 7.8a4 4 0 0 1-5.7-5.7L13.5 6a2.7 2.7 0 0 1 3.8 3.8L9.8 17.3a1.3 1.3 0 0 1-1.9-1.9L15 8.3" />
    </svg>
  );
}

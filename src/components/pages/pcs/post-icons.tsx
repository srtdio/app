// Two small glyphs F7 needs that the shared icon set does not carry: the inline
// edit pencil (title + caption) and the vertical kebab (the lightbox slide-action
// trigger). They mirror src/components/ui/icons.tsx exactly (same 24x24 grid,
// stroke and `inline` opt-in) so they read as part of the same family, and live
// here rather than in the shared set to keep the F7 surface self-contained.

import type { ReactNode } from 'react';
import type { IconProps } from '@/components/ui/icons';

function Glyph({
  className,
  size = 18,
  inline = false,
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      style={inline ? { display: 'inline-block', verticalAlign: '-0.15em' } : undefined}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function IconPencil(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 20h4L18.5 9.5a1.98 1.98 0 0 0 0-2.8l-1.2-1.2a1.98 1.98 0 0 0-2.8 0L4 16v4Z" />
      <path d="M13.4 6.6l4 4" />
    </Glyph>
  );
}

export function IconMoreVertical(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx={12} cy={5} r={1.3} />
      <circle cx={12} cy={12} r={1.3} />
      <circle cx={12} cy={19} r={1.3} />
    </Glyph>
  );
}

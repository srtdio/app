import { Children, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { GUTTER } from '@/components/ui/layout';

export interface ToolbarProps {
  /** Left: the search field (ui/Input tone search) or a segment row. Grows. */
  context?: ReactNode;
  /** Bare IconButtons (at most one in a list toolbar; CLAUDE.md List toolbars). */
  icons?: ReactNode;
  /** The filled primary (New), always last. */
  primary?: ReactNode;
  /** Drop the page gutter (the toolbar sits inside a padded surface). */
  flush?: boolean;
  className?: string;
}

/**
 * The one toolbar: a 56 bar of 44 controls. context | space | bare icons |
 * primary. Visible gaps: bare to bare 24 (the 44 boxes touch: gap 0), bare to
 * filled 12 (box gap 0, the glyph's own 12 inset), filled to filled 8.
 */
export function Toolbar({ context, icons, primary, flush = false, className }: ToolbarProps) {
  const iconCount = Children.count(icons);
  return (
    <div
      data-toolbar=""
      className={cn('flex h-14 min-w-0 items-center gap-2', !flush && GUTTER, className)}
    >
      {context !== undefined ? (
        <div data-toolbar-context="" className="flex min-w-0 flex-1 items-center">
          {context}
        </div>
      ) : (
        <span className="flex-1" />
      )}
      {iconCount > 0 ? (
        // gap 0: two bare 44 boxes touch, so their 20 glyphs sit 24 apart.
        <div data-toolbar-icons="" className="-mr-2 flex shrink-0 items-center gap-0 last:-mr-3">
          {icons}
        </div>
      ) : null}
      {primary !== undefined ? (
        <div data-toolbar-primary="" className="flex shrink-0 items-center gap-2">
          {primary}
        </div>
      ) : null}
    </div>
  );
}

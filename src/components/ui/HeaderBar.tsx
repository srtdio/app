import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { textRole } from '@/components/ui/Text';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, IconChevronLeft } from '@/components/ui/icons';
import { GUTTER, LEADING_PULL } from '@/components/ui/layout';

export interface HeaderBarProps {
  /** One line, truncated (title role). */
  title: ReactNode;
  /** Pushed screen: the back "<" (label Back). Root screens pass `mark` instead. */
  onBack?: () => void;
  /** Root screen: the workspace mark in the leading slot. */
  mark?: ReactNode;
  /** Up to two IconButtons, then the ⋯ last (its trigger applies the trailing rule). */
  actions?: ReactNode;
  /** A second line under the title (meta role), optional. */
  subtitle?: ReactNode;
  /** 56 phone, 64 laptop by default; `compact` keeps 56 on both. */
  compact?: boolean;
  className?: string;
}

/**
 * The one header bar: 56 (64 laptop), gutter 16/24. Leading 44: back "<" when
 * pushed (pulled out by 12 so the glyph sits on the edge), the workspace mark
 * at root. Title one line. Trailing up to two IconButtons + ⋯ last. Glyphs 20.
 */
export function HeaderBar({
  title,
  onBack,
  mark,
  actions,
  subtitle,
  compact = false,
  className,
}: HeaderBarProps) {
  return (
    <header
      data-header-bar=""
      className={cn(
        'flex min-w-0 shrink-0 items-center gap-2 border-b bg-panel lit-header',
        compact ? 'h-14' : 'h-14 md:h-16',
        GUTTER,
        className,
      )}
    >
      {onBack !== undefined ? (
        <IconButton label="Back" onClick={onBack} className={LEADING_PULL}>
          <IconChevronLeft size={ICON_SIZE.control} />
        </IconButton>
      ) : mark !== undefined ? (
        <span className="flex shrink-0 items-center">{mark}</span>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 className={textRole('title', 'truncate')}>{title}</h1>
        {subtitle !== undefined ? (
          <span className={textRole('meta', 'truncate')}>{subtitle}</span>
        ) : null}
      </div>
      {actions !== undefined ? (
        <div
          data-header-actions=""
          className="flex shrink-0 items-center gap-0 [&>button:last-child]:-mr-3"
        >
          {actions}
        </div>
      ) : null}
    </header>
  );
}

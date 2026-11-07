import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
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
  /**
   * The back "<"'s own name and hooks: its label (default "Back", e.g. "Close
   * contact info"), a ref for focus, data-* test hooks. Behaviour only; the
   * part owns its look, its glyph and the leading pull.
   */
  backProps?: Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    'className' | 'children' | 'onClick' | 'type'
  > & {
    label?: string;
    buttonRef?: Ref<HTMLButtonElement> | undefined;
    [hook: `data-${string}`]: string | undefined;
  };
  /** Root screen: the workspace mark in the leading slot. */
  mark?: ReactNode;
  /** Up to two IconButtons, then the ⋯ last (its trigger applies the trailing rule). */
  actions?: ReactNode;
  /** A second line under the title (meta role), optional. */
  subtitle?: ReactNode;
  /** 56 phone, 64 laptop by default; `compact` keeps 56 on both. */
  compact?: boolean;
  /**
   * The screen's own h1 (PageHead): tabIndex -1 so a route change can move
   * focus to it (src/lib/route-a11y.ts); never a Tab stop, no focus line.
   * Default false: the title is a plain h1.
   */
  routeFocus?: boolean;
  /**
   * A control in the title's place (a title menu button, an inline rename
   * field). It sits in the same title column; the caller renders it with the
   * title role. Default: the plain h1.
   */
  titleSlot?: ReactNode;
  /** Hooks on the title column (data-* and tabIndex for a panel's focus target). Behaviour only. */
  titleProps?: {
    tabIndex?: number;
    [hook: `data-${string}`]: string | undefined;
  };
  /** Drawn under the bar, anchored to it (a header menu); the bar stacks above the body. */
  overlay?: ReactNode;
  /** Ref to the <header> (a page anchors its scroll or motion to the bar). Behaviour only. */
  barRef?: Ref<HTMLElement> | undefined;
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
  backProps,
  mark,
  actions,
  subtitle,
  compact = false,
  routeFocus = false,
  titleSlot,
  titleProps,
  overlay,
  barRef,
  className,
}: HeaderBarProps) {
  return (
    <header
      ref={barRef}
      data-header-bar=""
      className={cn(
        'flex min-w-0 shrink-0 items-center gap-2 border-b bg-panel lit-header',
        compact ? 'h-14' : 'h-14 md:h-16',
        GUTTER,
        overlay !== undefined && 'relative z-sticky',
        className,
      )}
    >
      {onBack !== undefined ? (
        <IconButton
          {...backProps}
          type="button"
          label={backProps?.label ?? 'Back'}
          onClick={onBack}
          className={LEADING_PULL}
        >
          <IconChevronLeft size={ICON_SIZE.control} />
        </IconButton>
      ) : mark !== undefined ? (
        <span className="flex shrink-0 items-center">{mark}</span>
      ) : null}
      <div
        {...titleProps}
        className={cn(
          'flex min-w-0 flex-1 flex-col',
          titleProps?.tabIndex !== undefined && 'rounded-lg focus:outline-none',
        )}
      >
        {titleSlot ?? (
          <h1
            {...(routeFocus ? { tabIndex: -1 } : {})}
            className={textRole('title', cn('truncate', routeFocus && 'focus:outline-none'))}
          >
            {title}
          </h1>
        )}
        {subtitle !== undefined ? (
          <span className={textRole('meta', 'truncate')}>{subtitle}</span>
        ) : null}
      </div>
      {actions !== undefined ? (
        <div
          data-header-actions=""
          // The trailing rule pulls only a 44 icon box (w-11); a text action keeps its text on the edge (L6).
          className="flex shrink-0 items-center gap-0 [&>button.w-11:last-child]:-mr-3"
        >
          {actions}
        </div>
      ) : null}
      {overlay}
    </header>
  );
}

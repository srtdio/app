import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '@/lib/cn';
import { textRole } from '@/components/ui/Text';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, IconChevronLeft } from '@/components/ui/icons';
import {
  BAR_TITLE_AFTER_KEY,
  GUTTER,
  INK_TRAILING_LAST,
  LEADING_PULL,
} from '@/components/ui/layout';
import { PINNED_BAR_TOP_CLASS } from '@/lib/scroll-mode';

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
  /**
   * A second line the caller renders itself (its own Text role), in the
   * subtitle's place; wins over `subtitle`. Absent: unchanged.
   */
  subtitleSlot?: ReactNode;
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
  /**
   * Phone only: a title that must be read whole (a question, a rule) wraps to
   * two lines inside the 56 bar instead of cutting. Default false: one line.
   */
  titleWraps?: boolean;
  /** Hooks on the title column (data-* and tabIndex for a panel's focus target). Behaviour only. */
  titleProps?: {
    tabIndex?: number;
    [hook: `data-${string}`]: string | undefined;
  };
  /** Drawn under the bar, anchored to it (a header menu); the bar stacks above the body. */
  overlay?: ReactNode;
  /** Ref to the <header> (a page anchors its scroll or motion to the bar). Behaviour only. */
  barRef?: Ref<HTMLElement> | undefined;
  /**
   * The exit bar of a screen that opens over the app on the page scroller
   * (Post detail, Brief detail): it stays pinned while the page scrolls,
   * sticky at PINNED_BAR_TOP_CLASS (0 on a phone, where the bar covers the
   * status bar itself; below the Topbar on a touch tablet; 0 in a laptop's
   * <main>). Sheets and panels with their own fixed header leave it off.
   */
  pinned?: boolean;
  /**
   * Pinned only: rows pinned with the bar, directly under it, in the same
   * block (the post's checkpoint progress row). The block is one lit surface
   * (lit-header on the block, the bar's own shade dropped); a row draws its own
   * hairline (border-t) so an empty slot adds no line.
   */
  below?: ReactNode;
  className?: string;
}

/**
 * The one header bar: 56 (64 laptop), gutter 16/24. Leading 44: back "<" when
 * pushed (pulled out by 12 so the glyph sits on the edge; on phone its ink is
 * on 16 and the title starts at 64), the workspace mark at root. Title one line. Trailing up to two IconButtons + ⋯ last. Glyphs 20.
 */
export function HeaderBar({
  title,
  onBack,
  backProps,
  mark,
  actions,
  subtitle,
  subtitleSlot,
  compact = false,
  routeFocus = false,
  titleSlot,
  titleWraps = false,
  titleProps,
  overlay,
  barRef,
  pinned = false,
  below,
  className,
}: HeaderBarProps) {
  // Pinned with rows under it: the block pins and carries the one lit surface.
  const block = pinned && below !== undefined;
  const bar = (
    <header
      ref={barRef}
      data-header-bar=""
      {...(pinned ? { 'data-header-pinned': '' } : {})}
      className={cn(
        'flex min-w-0 shrink-0 items-center gap-2 bg-panel',
        block ? null : 'border-b lit-header',
        compact ? 'h-14' : 'h-14 md:h-16',
        GUTTER,
        pinned && !block
          ? cn('sticky z-sticky', PINNED_BAR_TOP_CLASS)
          : overlay !== undefined && 'relative z-sticky',
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
          // Beside the back "<" the title starts on the 64 text column (phone).
          onBack !== undefined && BAR_TITLE_AFTER_KEY,
          titleProps?.tabIndex !== undefined && 'rounded-lg focus:outline-none',
        )}
      >
        {titleSlot ?? (
          <h1
            {...(routeFocus ? { tabIndex: -1 } : {})}
            className={textRole(
              'title',
              cn(
                titleWraps ? 'max-md:line-clamp-2 md:truncate' : 'truncate',
                routeFocus && 'focus:outline-none',
              ),
            )}
          >
            {title}
          </h1>
        )}
        {subtitleSlot !== undefined ? (
          subtitleSlot
        ) : subtitle !== undefined ? (
          <span className={textRole('meta', 'truncate')}>{subtitle}</span>
        ) : null}
      </div>
      {actions !== undefined ? (
        <div
          data-header-actions=""
          // The trailing rule pulls only a 44 icon box (w-11); a text action keeps its text on the edge (L6).
          // On phone the last key's glyph slides so its ink sits on the edge (INK_TRAILING_LAST).
          className={cn(
            'flex shrink-0 items-center gap-0 [&>button.w-11:last-child]:-mr-3',
            INK_TRAILING_LAST,
          )}
        >
          {actions}
        </div>
      ) : null}
      {overlay}
    </header>
  );
  if (!block) return bar;
  return (
    <div
      data-header-pin=""
      className={cn('sticky z-sticky flex flex-col bg-panel lit-header', PINNED_BAR_TOP_CLASS)}
    >
      {bar}
      {below}
    </div>
  );
}

import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '@/lib/cn';
import { PressableRow } from '@/components/ui/PressableRow';
import { textRole } from '@/components/ui/Text';
import { ICON_SIZE, IconChevronRight } from '@/components/ui/icons';
import { CHAT_GUTTER } from '@/components/ui/layout';

/**
 * The tap surface's own attributes (pointer, key and context-menu handlers,
 * aria-pressed, data-* hooks), forwarded to the PressableRow as they are. They
 * change behaviour only, never the look: the part owns every class.
 */
type RowSurfaceProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'title' | 'onClick' | 'className' | 'children' | 'disabled' | 'type'
>;

export interface RowProps extends RowSurfaceProps {
  /** Leading avatar (32) or icon (20): held in a fixed 32 column so labels share one edge (L5). */
  leading?: ReactNode;
  /** Top line title (heading role). */
  title: ReactNode;
  /** Top line trailing time (meta role). */
  time?: ReactNode;
  /** Second line (secondary role): one line, truncated. Makes the row 72 tall. */
  secondary?: ReactNode;
  /**
   * A count on the second line's trailing end (an unread CountBadge), 8 after
   * the secondary text; on the title line after the time when there is no
   * second line. Never a control.
   */
  badge?: ReactNode;
  /** A chevron (the row opens somewhere) OR a ⋯ menu, never both. */
  trailing?:
    | { kind: 'chevron' }
    | { kind: 'more'; menu: ReactNode }
    | { kind: 'node'; node: ReactNode };
  /** Divider under the row, inset 60 (it starts on the text edge). */
  divider?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  /** Current / chosen row: lit-selected. */
  selected?: boolean;
  /** Ref to the tap surface's <button> (a menu anchors to it). */
  buttonRef?: Ref<HTMLButtonElement> | undefined;
  /**
   * Drop the row's own 16 inset (the row sits inside a padded surface, such as
   * a sheet body, whose padding is already the content edge). Default false.
   */
  flush?: boolean;
  /**
   * The row's side inset. 'page' (default): the 16 page edge. 'chat': the 12
   * chat edge (CHAT_GUTTER), the chat list's notes, group and people rows; the
   * text then starts at 56 and the divider is inset 56. Ignored when flush.
   */
  gutter?: 'page' | 'chat';
  className?: string;
}

/**
 * The one list row, built on PressableRow. 56 tall (one line + meta) or 72
 * (two lines); leading at the 16 inset, gap 12, text at 60; divider inset 60.
 * The ⋯ trailing is a sibling of the tap surface (buttons never nest) and
 * takes the trailing rule through ActionMenuTrigger.
 */
export function Row({
  leading,
  title,
  time,
  secondary,
  badge,
  trailing,
  divider = false,
  onPress,
  disabled,
  selected = false,
  buttonRef,
  flush = false,
  gutter = 'page',
  className,
  ...surface
}: RowProps) {
  const chat = !flush && gutter === 'chat';
  const inset = flush ? 'px-0' : chat ? CHAT_GUTTER : 'px-4';
  const trailingInset = flush ? 'pr-0' : chat ? 'pr-3' : 'pr-4';
  const badgeNode =
    badge !== undefined && badge !== null ? (
      <span data-row-badge="" className="flex shrink-0">
        {badge}
      </span>
    ) : null;
  const body = (
    <>
      {leading !== undefined ? (
        <span data-row-leading="" className="flex w-8 shrink-0 items-center justify-center">
          {leading}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={textRole('heading', 'min-w-0 flex-1 truncate')}>{title}</span>
          {time !== undefined ? <span className={textRole('meta', 'shrink-0')}>{time}</span> : null}
          {secondary === undefined ? badgeNode : null}
        </span>
        {secondary !== undefined ? (
          <span className="flex min-w-0 items-center gap-2">
            <span className={textRole('secondary', 'min-w-0 flex-1')}>{secondary}</span>
            {badgeNode}
          </span>
        ) : null}
      </span>
      {trailing?.kind === 'chevron' ? (
        <span aria-hidden="true" data-row-chevron="" className="flex shrink-0 text-fg-3">
          <IconChevronRight size={ICON_SIZE.control} />
        </span>
      ) : null}
    </>
  );
  const height = secondary !== undefined ? 'min-h-18' : 'min-h-14';
  return (
    <div data-row="" className={cn('relative flex min-w-0 items-center', className)}>
      {onPress !== undefined ? (
        <PressableRow
          {...surface}
          buttonRef={buttonRef}
          onClick={onPress}
          disabled={disabled}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-3 rounded-none',
            inset,
            height,
            selected && 'lit-selected',
          )}
        >
          {body}
        </PressableRow>
      ) : (
        <div className={cn('flex min-w-0 flex-1 items-center gap-3', inset, height)}>{body}</div>
      )}
      {trailing?.kind === 'more' ? (
        <span data-row-more="" className={cn('flex shrink-0', trailingInset)}>
          {trailing.menu}
        </span>
      ) : null}
      {trailing?.kind === 'node' ? (
        // The trailing rule for a caller's IconButton (a 44 box, pulled out by 12).
        <span data-row-trailing="" className={cn('flex shrink-0 [&>button]:-mr-3', trailingInset)}>
          {trailing.node}
        </span>
      ) : null}
      {divider ? (
        <span
          aria-hidden="true"
          data-row-divider=""
          className={cn(
            'pointer-events-none absolute bottom-0 right-0 h-px bg-border',
            flush ? 'left-11' : chat ? 'left-14' : 'left-15',
          )}
        />
      ) : null}
    </div>
  );
}

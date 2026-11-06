import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref } from 'react';
import { cn } from '@/lib/cn';
import { textRole } from '@/components/ui/Text';
import { PRESSABLE_ROW_BASE, PressableRow } from '@/components/ui/PressableRow';
import { CONTROL_IN_LINE } from '@/components/ui/layout';

/**
 * The whole card as one tap surface (a board card that opens its post): a
 * PressableRow laid behind the content at the card's corners (the hover and
 * press overlay, the focus line). Its attributes (aria-label, pointer and key
 * handlers) are forwarded as they are; the part owns every class. The content
 * lets taps through to it; the header ⋯ stays its own control above it.
 */
export type CardPress = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'children' | 'type'
>;

/**
 * The card root's own hooks: a ref (a page grows out of the card), data-*
 * (the tour, tests) and the long-press / right-click handlers. Behaviour only.
 */
export type CardSurface = Omit<HTMLAttributes<HTMLElement>, 'className' | 'children'> & {
  [hook: `data-${string}`]: string | undefined;
};

export interface CardProps {
  /** Header leading slot: an avatar (32) or a kind icon (20). */
  leading?: ReactNode;
  /** Header title (heading role, one line). */
  title?: ReactNode;
  /** Header trailing time (meta role). */
  time?: ReactNode;
  /**
   * Header trailing ⋯: an ActionMenu (its trigger applies the trailing rule),
   * or a bare IconButton (a remove X), which the part pulls by the same rule.
   */
  more?: ReactNode;
  /** One meta line under the header. */
  meta?: ReactNode;
  /** Free body content. */
  children?: ReactNode;
  /** A picture. Bleeds to the card edge with top corners only, or sits inset (radius 4). */
  media?: ReactNode;
  mediaInset?: boolean;
  /** Footer leading badge (a Tag). */
  badge?: ReactNode;
  /** Footer trailing: meta text or a Button. */
  footerTrailing?: ReactNode;
  /** 12 inside instead of 16 (chat tiles). */
  dense?: boolean;
  /** The quieter card surface (lit-card-muted). */
  muted?: boolean;
  /** Current / chosen card (today's day card): lit-selected in place of the card height. */
  selected?: boolean;
  as?: 'div' | 'article' | 'li' | 'section';
  /** The card opens something: one tap surface behind the content. */
  press?: CardPress;
  /**
   * The card's one real link (a router Link to its page), in place of `press`:
   * laid behind the content at the card's corners, the same as press. The
   * caller gives the link CARD_COVER (the part's classes) and its name.
   */
  cover?: ReactNode;
  /** Ref to the card root. */
  rootRef?: Ref<HTMLElement> | undefined;
  /** The root's hooks (data-*, gesture handlers). */
  surface?: CardSurface;
  /** The title keeps two lines (a board card's title), else one line. */
  titleLines?: 1 | 2;
  className?: string;
  /** Passthrough for tests and the tour. */
  'data-card'?: string;
  /** Other data-* hooks (tests, drag targets, scroll anchors). Behaviour only. */
  [hook: `data-${string}`]: string | undefined;
}

/** The card surface classes: radius 12, edge, panel fill, one lit height. */
export function cardSurface(muted = false, selected = false): string {
  return cn(
    'rounded-xl border bg-panel',
    selected ? 'lit-selected' : muted ? 'lit-card-muted' : 'lit-card',
  );
}

/**
 * The classes of a `cover` link: the press surface's look at the card's
 * corners, its focus line drawn inside the edge (the card clips overflow).
 */
export const CARD_COVER = cn(
  PRESSABLE_ROW_BASE.replace('focus-visible:lit-focus', 'focus-visible:lit-focus-inset'),
  'absolute inset-0 w-full rounded-xl',
);

/**
 * The card grid: one column on phone, auto-fill 320 columns that fill the
 * laptop width (tailwind gridTemplateColumns.cards). Gap 12.
 */
export const CARD_GRID = 'grid gap-3 md:grid-cols-cards';

/** Inner padding: 16, or 12 for the dense (chat tile) variant. */
export function cardPad(dense = false): string {
  return dense ? 'p-3' : 'p-4';
}

/**
 * The one card. Slots: header {leading, title, time, more}, meta, body, media,
 * footer {badge, trailing}. Height is its content; it never stretches to a
 * sibling (self-start in a grid). Three roles at most: heading, meta, body.
 */
export function Card({
  leading,
  title,
  time,
  more,
  meta,
  children,
  media,
  mediaInset = false,
  badge,
  footerTrailing,
  dense = false,
  muted = false,
  as: Tag = 'div',
  press,
  cover,
  rootRef,
  surface,
  titleLines = 1,
  className,
  ...rest
}: CardProps) {
  const hasHeader =
    leading !== undefined || title !== undefined || time !== undefined || more !== undefined;
  const hasFooter = badge !== undefined || footerTrailing !== undefined;
  // One tap surface behind the content: a PressableRow (press) or a link (cover).
  const tapped = press !== undefined || cover !== undefined;
  return (
    <Tag
      {...surface}
      // A Ref<HTMLElement> fits every root tag; the cast only widens the tag union.
      ref={rootRef as Ref<never> | undefined}
      data-card={rest['data-card'] ?? ''}
      className={cn(
        'flex min-w-0 flex-col self-start overflow-hidden',
        cardSurface(muted),
        tapped && 'relative',
        className,
      )}
    >
      {press !== undefined ? (
        <PressableRow {...press} card data-card-press="" className="absolute inset-0" />
      ) : (
        cover
      )}
      {media !== undefined && !mediaInset ? (
        <div
          data-card-media="bleed"
          className={cn('overflow-hidden rounded-t-xl', tapped && 'pointer-events-none relative')}
        >
          {media}
        </div>
      ) : null}
      <div
        className={cn(
          'flex min-w-0 flex-col gap-2',
          cardPad(dense),
          tapped && 'pointer-events-none relative',
        )}
      >
        {hasHeader ? (
          <div data-card-header="" className="flex min-w-0 items-center gap-3">
            {leading !== undefined ? (
              <span className="flex shrink-0 items-center">{leading}</span>
            ) : null}
            {title !== undefined ? (
              <span
                data-card-title=""
                className={textRole(
                  'heading',
                  titleLines === 2
                    ? 'line-clamp-2 min-w-0 flex-1 [overflow-wrap:anywhere]'
                    : 'min-w-0 flex-1 truncate',
                )}
              >
                {title}
              </span>
            ) : (
              <span className="flex-1" />
            )}
            {time !== undefined ? (
              <span className={textRole('meta', 'shrink-0')}>{time}</span>
            ) : null}
            {more !== undefined ? (
              <span
                data-card-more=""
                className={cn(
                  // A bare IconButton here (a remove X) takes the trailing rule
                  // too; an ActionMenu trigger applies it itself.
                  'flex shrink-0 [&>button]:-mr-3',
                  CONTROL_IN_LINE,
                  // Above the press surface, live inside the pass-through body.
                  tapped && 'pointer-events-auto relative z-10',
                )}
              >
                {more}
              </span>
            ) : null}
          </div>
        ) : null}
        {meta !== undefined ? <span className={textRole('meta', 'truncate')}>{meta}</span> : null}
        {children}
        {media !== undefined && mediaInset ? (
          <div data-card-media="inset" className="overflow-hidden rounded-inset">
            {media}
          </div>
        ) : null}
        {hasFooter ? (
          <div data-card-footer="" className="flex min-w-0 items-center gap-2">
            {badge !== undefined ? <span className="flex min-w-0 shrink">{badge}</span> : null}
            <span className="flex-1" />
            {footerTrailing !== undefined ? (
              <span className={textRole('meta', 'flex shrink-0 items-center')}>
                {footerTrailing}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </Tag>
  );
}

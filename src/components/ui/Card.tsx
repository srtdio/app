import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { textRole } from '@/components/ui/Text';
import { CONTROL_IN_LINE } from '@/components/ui/layout';

export interface CardProps {
  /** Header leading slot: an avatar (32) or a kind icon (20). */
  leading?: ReactNode;
  /** Header title (heading role, one line). */
  title?: ReactNode;
  /** Header trailing time (meta role). */
  time?: ReactNode;
  /** Header trailing ⋯: an ActionMenu (its trigger applies the trailing rule). */
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
  as?: 'div' | 'article' | 'li' | 'section';
  className?: string;
  /** Passthrough for tests and the tour. */
  'data-card'?: string;
}

/** The card surface classes: radius 12, edge, panel fill, one lit height. */
export function cardSurface(muted = false): string {
  return cn('rounded-xl border bg-panel', muted ? 'lit-card-muted' : 'lit-card');
}

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
  className,
  ...rest
}: CardProps) {
  const hasHeader =
    leading !== undefined || title !== undefined || time !== undefined || more !== undefined;
  const hasFooter = badge !== undefined || footerTrailing !== undefined;
  return (
    <Tag
      data-card={rest['data-card'] ?? ''}
      className={cn(
        'flex min-w-0 flex-col self-start overflow-hidden',
        cardSurface(muted),
        className,
      )}
    >
      {media !== undefined && !mediaInset ? (
        <div data-card-media="bleed" className="overflow-hidden rounded-t-xl">
          {media}
        </div>
      ) : null}
      <div className={cn('flex min-w-0 flex-col gap-2', cardPad(dense))}>
        {hasHeader ? (
          <div data-card-header="" className="flex min-w-0 items-center gap-3">
            {leading !== undefined ? (
              <span className="flex shrink-0 items-center">{leading}</span>
            ) : null}
            {title !== undefined ? (
              <span className={textRole('heading', 'min-w-0 flex-1 truncate')}>{title}</span>
            ) : (
              <span className="flex-1" />
            )}
            {time !== undefined ? (
              <span className={textRole('meta', 'shrink-0')}>{time}</span>
            ) : null}
            {more !== undefined ? (
              <span data-card-more="" className={cn('flex shrink-0', CONTROL_IN_LINE)}>
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

import type { ComponentType, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { textRole } from '@/components/ui/Text';
import { ICON_SIZE } from '@/components/ui/icons';
import type { IconProps } from '@/components/ui/icons';
import { PressableRow } from '@/components/ui/PressableRow';
import { BUBBLE_META_TYPE, BUBBLE_SHAPE, sized, useChatLayout } from '@/components/chat/chat-type';

export interface ChatCardProps {
  /** The kind glyph (20) on line 1: plan, post, brief, idea. */
  icon: ComponentType<IconProps>;
  /** Line 1 title (heading role, one line). */
  title: ReactNode;
  /** Line 2 meta (a range, a stage Tag, a count). */
  meta?: ReactNode;
  /** Optional preview under the meta (a picture or a short caption). */
  preview?: ReactNode;
  /** Optional 44 action row: secondary left, primary right, no divider. */
  secondaryAction?: ReactNode;
  primaryAction?: ReactNode;
  /** Bottom-trailing time and tick, inside the card. */
  time?: ReactNode;
  tick?: ReactNode;
  /** Own message: the own-bubble fill; peer: the peer bubble fill. */
  own?: boolean;
  /** Tap to open (the whole card), when there is no action row to tap instead. */
  onOpen?: () => void;
  /** Accessible name for the open tap. */
  openLabel?: string;
  /** Muted (unavailable) card: fg-3 ink, no tap. */
  muted?: boolean;
  className?: string;
  /** Extra rows (a progress bar) between the meta and the actions. */
  children?: ReactNode;
}

/** The width every chat card takes: 288, never past the bubble column. */
export const CHAT_CARD_WIDTH = 'w-72 max-w-full';

/** The card's bubble surface: the bubble radius (chat-type), the card fill and one lit height. */
export function chatCardSurface(layout: 'touch' | 'laptop', own: boolean): string {
  return cn(
    sized(BUBBLE_SHAPE, layout),
    // The same fills and lit heights as a text bubble (MessageThread bubbleClass).
    own ? 'bg-bubble-own text-accent-fg lit-bubble-own' : 'bg-panel-2 text-fg lit-bubble-other',
  );
}

/**
 * The one chat card: the card IS the bubble (same radius as a text bubble, no
 * wrapper bubble). Line 1: kind icon (20) + title; line 2: meta; optional
 * preview; optional 44 action row (secondary left, primary right); time and
 * tick bottom-trailing inside. Three roles: heading, meta, label (the buttons).
 */
export function ChatCard({
  icon: Icon,
  title,
  meta,
  preview,
  secondaryAction,
  primaryAction,
  time,
  tick,
  own = false,
  onOpen,
  openLabel,
  muted = false,
  className,
  children,
}: ChatCardProps) {
  const layout = useChatLayout();
  const head = (
    <>
      <span className="flex min-w-0 items-center gap-3">
        <span aria-hidden="true" className={cn('flex shrink-0', muted ? 'text-fg-3' : 'text-fg-2')}>
          <Icon size={ICON_SIZE.control} />
        </span>
        <span className={textRole('heading', cn('min-w-0 flex-1 truncate', muted && 'text-fg-3'))}>
          {title}
        </span>
      </span>
      {meta !== undefined ? (
        <span data-chat-card-meta="" className="flex min-w-0 items-center gap-2 pl-8">
          {meta}
        </span>
      ) : null}
    </>
  );
  const hasActions = secondaryAction !== undefined || primaryAction !== undefined;
  return (
    <div
      data-chat-card=""
      className={cn(
        'flex flex-col gap-2 p-3',
        CHAT_CARD_WIDTH,
        chatCardSurface(layout, own),
        className,
      )}
    >
      {onOpen !== undefined && !muted ? (
        <PressableRow
          inline
          aria-label={openLabel}
          onClick={onOpen}
          className="-m-1 flex w-auto min-w-0 flex-col items-stretch gap-1 p-1 mv-tint"
        >
          {head}
        </PressableRow>
      ) : (
        <div className="flex min-w-0 flex-col gap-1">{head}</div>
      )}
      {preview !== undefined ? <div data-chat-card-preview="">{preview}</div> : null}
      {children}
      {hasActions ? (
        <div data-chat-card-actions="" className="flex min-h-11 items-center gap-2">
          {secondaryAction ?? <span />}
          <span className="flex-1" />
          {primaryAction}
        </div>
      ) : null}
      {time !== undefined || tick !== undefined ? (
        <span
          data-chat-card-time=""
          className={cn(
            'flex items-center justify-end gap-1 self-end font-mono',
            BUBBLE_META_TYPE,
            own ? 'text-accent-fg' : 'text-fg-3',
          )}
        >
          {time}
          {tick}
        </span>
      ) : null}
    </div>
  );
}

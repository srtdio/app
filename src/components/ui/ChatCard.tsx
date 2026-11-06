import { createContext, useContext } from 'react';
import type { ComponentType, HTMLAttributes, ReactNode, Ref } from 'react';
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
  /**
   * Own message: the own-bubble fill; peer: the peer bubble fill. Absent: the
   * nearest ChatCardOwn (the message that holds the card), else peer.
   */
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
  /**
   * The root's own attributes: its data-* test hooks, aria, a ref, and for a
   * card that is one press target as a whole (the shared post card: tap opens
   * its sheet, a hold talks about it) role="button" with its handlers. A
   * role="button" root takes the card's press look (hover fill, focus line).
   */
  rootProps?: ChatCardRootProps;
}

/** ChatCard's root attributes (className and children stay the card's own). */
export type ChatCardRootProps = Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'children'> & {
  ref?: Ref<HTMLDivElement>;
} & { [hook: `data-${string}`]: string | undefined };

/** A whole-card press target's look: the hover / press overlay and the one focus line. */
const CHAT_CARD_PRESS = 'cursor-pointer lit-hover mv-tint focus-visible:lit-focus';

/**
 * Whose message holds the cards below: the thread wraps each message's cards
 * in it, so every card kind and state (live, loading, failed, not visible)
 * takes the own-bubble fill in an own message without each card file passing
 * it. No provider: peer. Render only; no read.
 */
const ChatCardOwnContext = createContext(false);
export const ChatCardOwn = ChatCardOwnContext.Provider;

/**
 * The own card's child ink: every line, meta, tag and action label inside the
 * own-bubble fill reads on it (the on-bubble ink, the same value as
 * accent-fg), and inner fills take the on-bubble overlay, never a light panel
 * over the text. The same mapping the own bubble used for cards before the
 * card became the bubble (MessageThread OWN_BUBBLE_CONTENT).
 */
export const OWN_CARD_INK = cn(
  '[&_.text-fg]:text-accent-fg [&_.text-fg-2]:text-accent-fg [&_.text-fg-3]:text-accent-fg [&_.text-accent]:text-accent-fg',
  '[&_.bg-panel]:bg-on-bubble/[.12] [&_.bg-panel-2]:bg-on-bubble/[.12] [&_.bg-panel-3]:bg-on-bubble/[.12] [&_.border-border]:border-on-bubble/[.16]',
  '[&_.bg-accent]:bg-on-bubble/70 [&_.bg-accent.text-accent-fg]:bg-on-bubble/[.16] [&_.bg-fg-3]:bg-on-bubble/40',
  '[&_.lit-card]:bg-none [&_.lit-card-muted]:bg-none [&_.lit-chip]:bg-none',
);

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
  own: ownProp,
  onOpen,
  openLabel,
  muted = false,
  className,
  children,
  rootProps,
}: ChatCardProps) {
  const layout = useChatLayout();
  const ownMessage = useContext(ChatCardOwnContext);
  const own = ownProp ?? ownMessage;
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
      {...rootProps}
      data-chat-card=""
      data-chat-card-own={own ? '' : undefined}
      data-own={own ? '' : undefined}
      className={cn(
        'flex flex-col gap-2 p-3',
        CHAT_CARD_WIDTH,
        chatCardSurface(layout, own),
        own && OWN_CARD_INK,
        rootProps?.role === 'button' && CHAT_CARD_PRESS,
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

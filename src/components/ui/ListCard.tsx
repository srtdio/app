import type {
  ButtonHTMLAttributes,
  ComponentType,
  HTMLAttributes,
  MouseEvent,
  ReactElement,
  ReactNode,
  Ref,
} from 'react';
import { useId } from 'react';
import { cn } from '@/lib/cn';
import { Bone, MOVE_CLASS } from '@/lib/motion';
import { TEXT_ROLE, textRole } from '@/components/ui/Text';
import { Tag } from '@/components/ui/Tag';
import { Avatar } from '@/components/ui/Avatar';
import { PostPlaceholder, type PostPlaceholderKind } from '@/components/ui/PostPlaceholder';
import { ICON_SIZE, type IconProps } from '@/components/ui/icons';
import { CONTROL_IN_LINE } from '@/components/ui/layout';

/** data-* hooks (tests, the tour, scroll anchors). Behaviour only, never the look. */
export type ListCardHooks = { [hook: `data-${string}`]: string | undefined };

/**
 * The picture slot (72x72, left, top-aligned, 12 to the text):
 * - person: the person's photo, a circle (ui/Avatar at 72; initials on their colour when none);
 * - image: a caller's picture (a thumbnail, a group photo or mark) in the radius 8 box;
 * - icon: a 24 glyph in fg-2 on the panel-2 radius 8 box (a brief, Personal notes);
 * - placeholder: ui/PostPlaceholder ("Aa", the play glyph) filling the radius 8 box.
 */
export type ListCardPicture =
  | { kind: 'person'; name: string; src?: string | null | undefined }
  | { kind: 'image'; node: ReactNode }
  | { kind: 'icon'; icon: ComponentType<IconProps> }
  | { kind: 'placeholder'; placeholder: PostPlaceholderKind };

/**
 * The whole-card tap surface's own attributes (aria-label, pointer, key and
 * context-menu handlers, aria-pressed, data-*), forwarded as they are. The
 * part owns every class.
 */
export type ListCardPress = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'children' | 'type' | 'onClick'
> &
  ListCardHooks;

/** The card root's own hooks: data-*, gesture handlers. Behaviour only. */
export type ListCardSurface = Omit<HTMLAttributes<HTMLElement>, 'className' | 'children'> &
  ListCardHooks;

export interface ListCardProps {
  picture: ListCardPicture;
  /** data-* hooks on the picture slot (data-person-photo, data-group-photo). */
  pictureHooks?: ListCardHooks;
  /** Line 1: the title (heading role, one line, truncated). */
  title: ReactNode;
  /** Line 1 trailing: the 8px unread dot, only when true. */
  unread?: boolean;
  /** Line 2: the preview (secondary role), at most 2 lines and always 2 lines tall. */
  preview?: ReactNode;
  /** data-* hooks on the preview line. */
  previewHooks?: ListCardHooks;
  /** Line 3, after the tag and " · ": the time (meta role); '' or absent shows none. */
  time?: ReactNode;
  /** data-* hooks on the time. */
  timeHooks?: ListCardHooks;
  /** The time is overdue: the bad token instead of fg-3 (never for approved). */
  timeBad?: boolean;
  /** Line 3 first: the one grey tag (ui/Tag neutral). */
  tag?: string | undefined;
  /** data-* hooks on the tag. */
  tagHooks?: ListCardHooks;
  /**
   * Line 3 trailing: an ActionMenu (its ActionMenuTrigger applies the trailing
   * rule), or a bare IconButton the part pulls by the same rule.
   */
  menu?: ReactNode;
  /**
   * Select mode: the check sits where the ⋮ sits (the footprint never changes).
   * It takes no taps: a tap on it is a tap on the card.
   */
  check?: ReactNode;
  /** The card opens something: the whole card is one button. */
  onPress?: () => void;
  /** The button's own attributes (aria-label, gestures, aria-pressed). */
  press?: ListCardPress;
  /** Ref to the whole-card button (a menu anchors to it). */
  pressRef?: Ref<HTMLButtonElement> | undefined;
  /**
   * The card's one real link (a router Link), in place of onPress: laid over
   * the whole card. The caller gives it LIST_CARD_COVER and its name.
   */
  cover?: ReactNode;
  /** The card is unavailable (select mode on an inert card): no tap. */
  disabled?: boolean;
  /** Current / chosen card (the open chat, a checked chat): lit-selected. */
  selected?: boolean;
  /** The quieter card surface (a closed brief). */
  muted?: boolean;
  as?: 'div' | 'li' | 'article';
  rootRef?: Ref<HTMLElement> | undefined;
  surface?: ListCardSurface;
  /** Other data-* hooks on the root. */
  [hook: `data-${string}`]: string | undefined;
}

/** The frame: border token, radius 12, panel fill; one lit height. */
export function listCardFrame(selected = false, muted = false): string {
  return cn(
    'relative flex min-w-0 overflow-hidden rounded-xl border bg-panel',
    selected ? 'lit-selected' : muted ? 'lit-card-muted' : 'lit-card',
  );
}

/** The inner row: padding 16, picture then text, 12 apart, top-aligned. */
export const LIST_CARD_BODY =
  'pointer-events-none relative flex min-w-0 flex-1 items-start gap-3 p-4';

/** The picture box: 72x72 (h-18 w-18), never shrinks. */
export const LIST_CARD_PICTURE = 'flex h-18 w-18 shrink-0 items-center justify-center';

/** The radius 8 box a non-person picture sits in, lit as media (lit-media, as the old cards). */
const PICTURE_BOX = 'lit-media overflow-hidden rounded-lg';

/** Line 1: title + unread dot, one 20 line. */
export const LIST_CARD_LINE1 = 'flex h-5 min-w-0 items-center gap-2';

/**
 * Line 2: two lines, always two lines tall (min-h-9 = 36 = 2 x 18), so every
 * card is the same height. The secondary role's truncate is undone so it wraps.
 */
export const LIST_CARD_PREVIEW = cn(
  TEXT_ROLE.secondary.replace('truncate', ''),
  'line-clamp-2 min-h-9 break-words [overflow-wrap:anywhere]',
);

/** Line 3: tag, " · ", time, space, ⋮; one 20 line (the 44 ⋮ keeps its box, CONTROL_IN_LINE). */
export const LIST_CARD_LINE3 = 'flex h-5 min-w-0 items-center gap-2';

/** The unread dot: 8px, round, fg ink. */
export const LIST_CARD_UNREAD_DOT = 'inline-block h-2 w-2 shrink-0 rounded-full bg-fg';

/** The list the cards stack in: 12 between cards (phone, and the chat list pane). */
export const LIST_CARD_STACK = 'flex flex-col gap-3';

/**
 * The page list: one column on phone, auto-fill columns at least 360 wide on
 * laptop (grid-cols-list-cards), 12 between cards both ways. Pipeline, Briefs,
 * Assets, Activity and the Plan tab; the chat list stays LIST_CARD_STACK.
 */
export const LIST_CARD_GRID = 'grid grid-cols-1 gap-3 md:grid-cols-list-cards';

/**
 * The tap surface laid over the whole card: the hover / press overlay and the
 * focus line inside the edge (the card clips overflow). The card itself sinks
 * (MOVE_CLASS.press on the root), so the overlay carries no press of its own.
 */
export const LIST_CARD_COVER =
  'absolute inset-0 w-full rounded-xl text-left lit-hover focus-visible:lit-focus-inset disabled:pointer-events-none disabled:cursor-default';

function Picture({
  picture,
  hooks,
}: {
  picture: ListCardPicture;
  hooks: ListCardHooks | undefined;
}): ReactElement {
  const kind = picture.kind;
  return (
    <span
      data-list-card-picture={kind}
      {...hooks}
      className={cn(LIST_CARD_PICTURE, kind !== 'person' && PICTURE_BOX)}
    >
      {picture.kind === 'person' ? (
        <Avatar
          name={picture.name}
          {...(picture.src !== null && picture.src !== undefined ? { src: picture.src } : {})}
          role="profile"
          decorative
        />
      ) : picture.kind === 'image' ? (
        <span className="flex h-full w-full items-center justify-center [&>*]:h-full [&>*]:w-full">
          {picture.node}
        </span>
      ) : picture.kind === 'icon' ? (
        <span
          aria-hidden="true"
          className="flex h-full w-full items-center justify-center bg-panel-2 text-fg-2"
        >
          <picture.icon size={ICON_SIZE.picture} />
        </span>
      ) : (
        <PostPlaceholder kind={picture.placeholder} size={ICON_SIZE.picture} fill />
      )}
    </span>
  );
}

/**
 * The one list card (Pipeline, Briefs, Assets, the Chat list, Activity, the
 * Plan tab and Bank): a bordered radius 12
 * card, padding 16, the whole card one tap target that sinks when pressed.
 * Left: the 72 picture. Right, three lines:
 *   1. title (heading) + the unread dot;
 *   2. preview (secondary), 2 lines, always 2 lines tall;
 *   3. one grey Tag + " · " + time (meta) + space + ⋮ (the trailing rule).
 * Three roles (heading, secondary, meta) plus the tag. Every card is the same
 * height: 1 + 16 + max(72, 20 + 4 + 36 + 4 + 20) + 16 + 1 = 118 (border, padding,
 * the text column; the 72 picture never sets it).
 */
/**
 * A click on the title is a click on the card: it hands the click to the card's
 * own tap target (the cover button or link), so the title text is a real hit
 * target and the card still has one button for keyboard and screen readers.
 */
function clickCover(event: MouseEvent<HTMLElement>): void {
  const root = event.currentTarget.closest('[data-list-card]');
  const target = root?.querySelector<HTMLElement>(':scope > button, :scope > a');
  target?.click();
}

export function ListCard({
  picture,
  pictureHooks,
  title,
  unread = false,
  preview,
  previewHooks,
  time,
  timeHooks,
  timeBad = false,
  tag,
  tagHooks,
  menu,
  check,
  onPress,
  press,
  pressRef,
  cover,
  disabled = false,
  selected = false,
  muted = false,
  as: Root = 'div',
  rootRef,
  surface,
  ...rest
}: ListCardProps) {
  const tapped = onPress !== undefined || cover !== undefined;
  // Line 3 reads tag, " · ", time: the tag comes first so a ticking time never
  // moves it; with no tag the time starts the line.
  const hasTag = tag !== undefined && tag !== '';
  const hasTime = time !== undefined && time !== '';
  const trailing = check ?? menu;
  // The cover button is named by what the card shows (title, unread, preview)
  // unless the caller gives its own aria-label; no copied text.
  const id = useId();
  const titleId = `${id}t`;
  const unreadId = `${id}u`;
  const previewId = `${id}p`;
  const labelledBy =
    press !== undefined && 'aria-label' in press && press['aria-label'] !== undefined
      ? undefined
      : [titleId, unread ? unreadId : null, previewId].filter(Boolean).join(' ');
  return (
    <Root
      {...surface}
      // A Ref<HTMLElement> fits every root tag; the cast only widens the tag union.
      ref={rootRef as Ref<never> | undefined}
      {...rest}
      data-list-card=""
      className={cn(listCardFrame(selected, muted), tapped && !disabled && MOVE_CLASS.press)}
    >
      {onPress !== undefined ? (
        <button
          {...(labelledBy !== undefined ? { 'aria-labelledby': labelledBy } : {})}
          {...press}
          ref={pressRef}
          type="button"
          disabled={disabled}
          onClick={onPress}
          data-list-card-press=""
          className={LIST_CARD_COVER}
        />
      ) : (
        cover
      )}
      <div data-list-card-body="" className={LIST_CARD_BODY}>
        <Picture picture={picture} hooks={pictureHooks} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div data-list-card-line="1" className={LIST_CARD_LINE1}>
            <span
              id={titleId}
              data-list-card-title=""
              {...(tapped && !disabled ? { onClick: clickCover } : {})}
              className={textRole(
                'heading',
                cn('min-w-0 flex-1 truncate', tapped && !disabled && 'pointer-events-auto'),
              )}
            >
              {title}
            </span>
            {unread ? (
              <span
                id={unreadId}
                data-list-card-unread=""
                role="img"
                aria-label="Unread"
                className={LIST_CARD_UNREAD_DOT}
              />
            ) : null}
          </div>
          <span
            id={previewId}
            data-list-card-preview=""
            {...previewHooks}
            className={LIST_CARD_PREVIEW}
          >
            {preview}
          </span>
          <div data-list-card-line="3" className={LIST_CARD_LINE3}>
            {hasTag ? (
              <span data-list-card-tag="" {...tagHooks} className="flex min-w-0 shrink">
                <Tag label={tag} tone="neutral" className="truncate" />
              </span>
            ) : null}
            {hasTag && hasTime ? (
              <span
                data-list-card-sep=""
                aria-hidden="true"
                className={textRole('meta', 'shrink-0')}
              >
                ·
              </span>
            ) : null}
            {hasTime ? (
              <span
                data-list-card-time=""
                {...(timeBad ? { 'data-list-card-time-bad': '' } : {})}
                {...timeHooks}
                className={textRole('meta', cn('shrink-0', timeBad && 'text-bad'))}
              >
                {time}
              </span>
            ) : null}
            <span className="flex-1" />
            {trailing !== undefined && trailing !== null ? (
              <span
                data-list-card-more=""
                className={cn(
                  // A bare IconButton takes the trailing rule here (TRAILING_PULL);
                  // an ActionMenuTrigger applies it itself. The 44 box keeps its
                  // size without growing the 20 line (CONTROL_IN_LINE).
                  'relative z-raised flex shrink-0',
                  // The select check is a mark, not a control: a tap on it falls
                  // through to the card, which toggles the selection.
                  check === undefined
                    ? ['pointer-events-auto [&>button]:-mr-3', CONTROL_IN_LINE].join(' ')
                    : 'pointer-events-none',
                )}
              >
                {trailing}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </Root>
  );
}

/**
 * A loading box in ListCard's own frame and slots (the 72 picture, the title
 * line, two preview lines, the meta line), so nothing moves when the cards
 * land. Pure render; the screen's BoxSkeleton decides when it shows.
 */
export function ListCardBox({
  round = false,
  ...hooks
}: { round?: boolean } & ListCardHooks): ReactElement {
  return (
    <div {...hooks} data-list-card-box="" className={listCardFrame()}>
      <div className={LIST_CARD_BODY}>
        <Bone
          lit={round ? 'lit-avatar' : 'flat'}
          className={cn(LIST_CARD_PICTURE, round ? 'rounded-full' : PICTURE_BOX)}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className={LIST_CARD_LINE1}>
            <Bone lit="flat" className="h-4 w-1/2 rounded" />
          </div>
          <div className="flex min-h-9 flex-col justify-center gap-2">
            <Bone lit="flat" className="h-3 w-full rounded" />
            <Bone lit="flat" className="h-3 w-2/3 rounded" />
          </div>
          <div className={LIST_CARD_LINE3}>
            <Bone lit="flat" className="h-3 w-16 rounded" />
          </div>
        </div>
      </div>
    </div>
  );
}

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
import { textRole } from '@/components/ui/Text';
import { Tag, type TagDot } from '@/components/ui/Tag';
import { Avatar } from '@/components/ui/Avatar';
import { PostPlaceholder, type PostPlaceholderKind } from '@/components/ui/PostPlaceholder';
import { ICON_SIZE, IconCheck, type IconProps } from '@/components/ui/icons';
import { useSelectGesture, type SelectGesture } from '@/components/ui/useLongPress';

/** data-* hooks (tests, the tour, scroll anchors). Behaviour only, never the look. */
export type ListCardHooks = { [hook: `data-${string}`]: string | undefined };

/**
 * The picture slot (48x48, left, vertically centred, 12 to the text):
 * - person: the person's photo, a circle (ui/Avatar 'card', 48; initials on their colour when none);
 *   `node` replaces the Avatar with a caller's 48 circle;
 * - image: a caller's picture (a thumbnail, a group photo or mark) in the radius 8 box;
 * - icon: a 24 glyph in fg-2 on the panel-2 radius 8 box (a brief, an activity kind);
 * - placeholder: ui/PostPlaceholder ("Aa", the play glyph) filling the radius 8 box.
 */
export type ListCardPicture =
  | { kind: 'person'; name: string; src?: string | null | undefined; node?: ReactNode }
  | { kind: 'image'; node: ReactNode }
  | { kind: 'icon'; icon: ComponentType<IconProps> }
  | { kind: 'placeholder'; placeholder: PostPlaceholderKind };

/**
 * Select mode on a list (long-press on phone, right-click / Shift-click /
 * Cmd-click on laptop; useSelectGesture). The card never carries a menu: the
 * old ⋮ actions live on the list's SelectBar.
 */
export type ListCardSelect = SelectGesture & {
  /** This card is ticked (lit-selected, the filled tick). */
  chosen: boolean;
};

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
  /** Line 1 trailing: the time (meta role, mono, no wrap); '' or absent shows none. */
  time?: ReactNode;
  /** data-* hooks on the time. */
  timeHooks?: ListCardHooks;
  /** The time is overdue: the bad token instead of fg-3 (never for approved). */
  timeBad?: boolean;
  /** Line 2: the preview (secondary role, ONE line, truncated). */
  preview?: ReactNode;
  /** data-* hooks on the preview. */
  previewHooks?: ListCardHooks;
  /** Line 2 after the preview: the one grey tag (ui/Tag neutral). */
  tag?: string | undefined;
  /** The tag's leading stage dot (Pipeline). */
  tagDot?: TagDot | undefined;
  /** data-* hooks on the tag. */
  tagHooks?: ListCardHooks;
  /** Line 2 last: the 8px unread dot, only when true. */
  unread?: boolean;
  /** Select mode for this list; absent: long-press and right-click do nothing. */
  select?: ListCardSelect | undefined;
  /** The card opens something: the whole card is one button. */
  onPress?: () => void;
  /** The button's own attributes (aria-label, aria-pressed, data-*). */
  press?: ListCardPress;
  /** Ref to the whole-card button. */
  pressRef?: Ref<HTMLButtonElement> | undefined;
  /**
   * The card's one real link (a router Link), in place of onPress: laid over
   * the whole card. The caller gives it LIST_CARD_COVER and its name.
   */
  cover?: ReactNode;
  /** The card is unavailable (an inert card in select mode): no tap. */
  disabled?: boolean;
  /** Current card (the open chat): lit-selected. A chosen card is selected too. */
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

/**
 * The card's exact height: 1 border + 12 padding + 48 picture + 12 padding +
 * 1 border. The text column (20 + 4 + 20 = 44) centres against the 48 picture.
 */
export const LIST_CARD_HEIGHT_PX = 74;

/**
 * The inner row: padding 12, picture then text, 12 apart, vertically centred.
 * No text selection, callout or magnifier on a hold (iOS long-press selects).
 */
export const LIST_CARD_BODY =
  'pointer-events-none relative flex min-w-0 flex-1 items-center gap-3 p-3';

/** The picture box: 48x48 (h-12 w-12), never shrinks. */
export const LIST_CARD_PICTURE = 'relative flex h-12 w-12 shrink-0 items-center justify-center';

/** The radius 8 box a non-person picture sits in, lit as media. */
const PICTURE_BOX = 'lit-media overflow-hidden rounded-lg';

/** The text column: two 20 lines, 4 apart (44). */
export const LIST_CARD_TEXT = 'flex min-w-0 flex-1 flex-col gap-1';

/** Line 1: title then the time on the right; one 20 line. */
export const LIST_CARD_LINE1 = 'flex h-5 min-w-0 items-center gap-2';

/** Line 2: preview, the tag, the unread dot; one 20 line, always there. */
export const LIST_CARD_LINE2 = 'flex h-5 min-w-0 items-center gap-2';

/** The preview: secondary role, one line, truncated. */
export const LIST_CARD_PREVIEW = textRole('secondary', 'min-w-0 flex-1 truncate');

/** The unread dot: 8px, round, fg ink. */
export const LIST_CARD_UNREAD_DOT = 'inline-block h-2 w-2 shrink-0 rounded-full bg-fg';

/** The list the cards stack in: 8 between cards (phone, and the chat list pane). */
export const LIST_CARD_STACK = 'flex flex-col gap-2';

/**
 * The page list: one column on phone, auto-fill columns at least 360 wide on
 * laptop (grid-cols-list-cards), 8 between cards both ways. Pipeline, Briefs,
 * Assets, Activity, the Plan tab and Bank; the chat list stays LIST_CARD_STACK.
 */
export const LIST_CARD_GRID = 'grid grid-cols-1 gap-2 md:grid-cols-list-cards';

/**
 * The tap surface laid over the whole card: the hover / press overlay and the
 * focus line inside the edge (the card clips overflow). The card itself sinks
 * (MOVE_CLASS.press on the root), so the overlay carries no press of its own.
 */
export const LIST_CARD_COVER =
  'absolute inset-0 w-full rounded-xl text-left lit-hover focus-visible:lit-focus-inset disabled:pointer-events-none disabled:cursor-default';

/** No text selection, callout or magnifier on a long-press (iOS). */
export const LIST_CARD_NO_CALLOUT = 'select-none [-webkit-touch-callout:none]';

/**
 * The select tick: a 20 round badge on the picture's bottom-right corner.
 * Chosen: filled ink with a check; not chosen: an empty fg-3 ring on the panel.
 * It scales in when select mode starts (mv-slide on transform; instant under
 * Reduce Motion) and never moves anything around it.
 */
export function listCardTickClass(active: boolean, chosen: boolean): string {
  return cn(
    'absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border',
    MOVE_CLASS.slide,
    active ? 'scale-100' : 'scale-0',
    chosen ? 'border-panel bg-fg text-panel' : 'border-fg-3 bg-panel',
  );
}

function Tick({ active, chosen }: { active: boolean; chosen: boolean }): ReactElement {
  return (
    <span
      aria-hidden="true"
      data-list-card-tick={active ? (chosen ? 'on' : 'off') : 'hidden'}
      className={listCardTickClass(active, chosen)}
    >
      {active && chosen ? <IconCheck size={ICON_SIZE.inline} /> : null}
    </span>
  );
}

function Picture({
  picture,
  hooks,
  select,
}: {
  picture: ListCardPicture;
  hooks: ListCardHooks | undefined;
  select: ListCardSelect | undefined;
}): ReactElement {
  const kind = picture.kind;
  return (
    <span data-list-card-picture={kind} {...hooks} className={LIST_CARD_PICTURE}>
      <span
        data-list-card-picture-box=""
        className={cn(
          'flex h-full w-full items-center justify-center',
          kind !== 'person' && PICTURE_BOX,
        )}
      >
        {picture.kind === 'person' && picture.node !== undefined ? (
          picture.node
        ) : picture.kind === 'person' ? (
          <Avatar
            name={picture.name}
            {...(picture.src !== null && picture.src !== undefined ? { src: picture.src } : {})}
            role="card"
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
      {select !== undefined ? <Tick active={select.active} chosen={select.chosen} /> : null}
    </span>
  );
}

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

/**
 * The one list card (Pipeline, Briefs, Assets, the Chat list, Activity, the
 * Plan tab and Bank), WhatsApp style: a bordered radius 12 card, padding 12,
 * the whole card one tap target that sinks when pressed. Left: the 48 picture,
 * vertically centred. Right, two lines:
 *   1. title (heading, one line) ... time (meta, right, the bad token when late);
 *   2. preview (secondary, one line) then the one grey Tag then the unread dot.
 * No third line and no ⋮: a card's actions live on its list's select bar
 * (long-press / right-click selects). Every card is exactly 74 tall
 * (LIST_CARD_HEIGHT_PX); line 2 stays even when it is empty.
 */
export function ListCard({
  picture,
  pictureHooks,
  title,
  time,
  timeHooks,
  timeBad = false,
  preview,
  previewHooks,
  tag,
  tagDot,
  tagHooks,
  unread = false,
  select,
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
  const hasTag = tag !== undefined && tag !== '';
  const hasTime = time !== undefined && time !== '';
  const hasPreview = preview !== undefined && preview !== null && preview !== '';
  const gesture = useSelectGesture(select);
  const chosen = select !== undefined && select.active && select.chosen;
  // The cover button is named by what the card shows (title, unread, preview)
  // unless the caller gives its own aria-label; no copied text.
  const id = useId();
  const titleId = `${id}t`;
  const unreadId = `${id}u`;
  const previewId = `${id}p`;
  const labelledBy =
    press !== undefined && 'aria-label' in press && press['aria-label'] !== undefined
      ? undefined
      : [titleId, hasPreview ? previewId : null, unread ? unreadId : null]
          .filter(Boolean)
          .join(' ');
  const pressAttrs =
    select !== undefined && select.active ? { ...press, 'aria-pressed': chosen } : press;
  return (
    <Root
      {...surface}
      {...gesture}
      // A Ref<HTMLElement> fits every root tag; the cast only widens the tag union.
      ref={rootRef as Ref<never> | undefined}
      {...rest}
      data-list-card=""
      {...(select !== undefined && select.active ? { 'data-list-card-selecting': '' } : {})}
      className={cn(
        listCardFrame(selected || chosen, muted),
        select !== undefined && LIST_CARD_NO_CALLOUT,
        tapped && !disabled && MOVE_CLASS.press,
      )}
    >
      {onPress !== undefined ? (
        <button
          {...(labelledBy !== undefined ? { 'aria-labelledby': labelledBy } : {})}
          {...pressAttrs}
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
        <Picture picture={picture} hooks={pictureHooks} select={select} />
        <div className={LIST_CARD_TEXT}>
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
            {hasTime ? (
              <span
                data-list-card-time=""
                {...(timeBad ? { 'data-list-card-time-bad': '' } : {})}
                {...timeHooks}
                className={textRole('meta', cn('shrink-0 whitespace-nowrap', timeBad && 'text-bad'))}
              >
                {time}
              </span>
            ) : null}
          </div>
          <div data-list-card-line="2" className={LIST_CARD_LINE2}>
            {hasPreview ? (
              <span
                id={previewId}
                data-list-card-preview=""
                {...previewHooks}
                className={LIST_CARD_PREVIEW}
              >
                {preview}
              </span>
            ) : null}
            {hasTag ? (
              <span data-list-card-tag="" {...tagHooks} className="flex min-w-0 shrink-0">
                <Tag
                  label={tag}
                  tone="neutral"
                  {...(tagDot !== undefined ? { dot: tagDot } : {})}
                  className="truncate"
                />
              </span>
            ) : null}
            {!hasPreview ? <span className="flex-1" /> : null}
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
        </div>
      </div>
    </Root>
  );
}

/**
 * A loading box in ListCard's own frame and slots (the 48 picture, the title
 * line with its time, the preview line), exactly 74 tall, so nothing moves
 * when the cards land. Pure render; the screen's BoxSkeleton decides when it shows.
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
        <div className={LIST_CARD_TEXT}>
          <div className={LIST_CARD_LINE1}>
            <Bone lit="flat" className="h-4 w-1/2 rounded" />
            <span className="flex-1" />
            <Bone lit="flat" className="h-3 w-10 rounded" />
          </div>
          <div className={LIST_CARD_LINE2}>
            <Bone lit="flat" className="h-3 w-2/3 rounded" />
          </div>
        </div>
      </div>
    </div>
  );
}

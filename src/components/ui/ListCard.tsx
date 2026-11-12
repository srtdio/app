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
import { CountBadge } from '@/components/ui/CountBadge';
import { PostPlaceholder, type PostPlaceholderKind } from '@/components/ui/PostPlaceholder';
import { ICON_SIZE, type IconProps } from '@/components/ui/icons';
import { SelectCheck } from '@/components/ui/SelectCheck';
import { useSelectGesture, type SelectGesture } from '@/components/ui/useLongPress';

/** data-* hooks (tests, the tour, scroll anchors). Behaviour only, never the look. */
export type ListCardHooks = { [hook: `data-${string}`]: string | undefined };

/**
 * The picture slot (48x48 from 768, vertically centred; 36x36 under 768, its
 * top on the title line's top; left, 12 to the text):
 * - person: the person's photo, a rounded square (ui/Avatar 'card', 48 / 36; initials on their colour when none);
 *   `node` replaces the Avatar with a caller's square filling the slot;
 * - image: a caller's picture (a thumbnail, a group photo or mark) in the rounded-picture (10) squircle;
 * - icon: a 20 glyph in fg-2 on the panel-2 squircle (a brief, an activity kind);
 * - placeholder: ui/PostPlaceholder ("Aa", the play glyph) filling the squircle.
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
  /** This card is ticked (the panel-2 fill, the filled tick). */
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
  /**
   * Activity only (10 Nov 2026): 2 when the preview wraps to two lines (or
   * more, unfolded). The row grows by one line (72 + 20; 60 + 20 under 768)
   * and the preview wraps instead of truncating; the caller cuts the text. Default 1:
   * every other list is unchanged.
   */
  previewLines?: 1 | 2;
  /** Line 2 after the preview: the one grey tag (ui/Tag neutral). */
  tag?: string | undefined;
  /** The tag's leading stage dot (Pipeline). */
  tagDot?: TagDot | undefined;
  /** data-* hooks on the tag. */
  tagHooks?: ListCardHooks;
  /** Line 2 last: the 8px unread dot, only when true. */
  unread?: boolean;
  /**
   * The unread dot is named for screen readers but not drawn, so the tag ends
   * on the right edge (under the time). Activity's item head only: its lines
   * carry the dots on that edge. The title still bolds while unread.
   */
  unreadDotHidden?: boolean;
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
  /** Current row (the open chat): the panel-2 fill. A chosen row is selected too. */
  selected?: boolean;
  /** The quieter row (a closed brief): the title greys to fg-3. */
  muted?: boolean;
  /**
   * The solid row (Activity's Catch up and Threads, 11 Nov 2026): the ink fill
   * (bg-accent, text in accent-fg), the picture tile on bg-panel with an fg
   * icon. Tokens only, so dark mode inverts by itself. Solid rows sit in
   * LIST_CARD_SOLID_GROUP. Default off: every other row is unchanged.
   */
  solid?: boolean;
  /**
   * A count pill (ui/CountBadge) at the right edge, vertically centred, in
   * place of the time, tag and unread dot (on-fill on a solid row). Nothing
   * at 0 or absent.
   */
  count?: number;
  as?: 'div' | 'li' | 'article';
  rootRef?: Ref<HTMLElement> | undefined;
  surface?: ListCardSurface;
  /** Other data-* hooks on the root. */
  [hook: `data-${string}`]: string | undefined;
}

/**
 * The row frame (flat look, 7 Nov 2026): no border, no radius, no lit height.
 * It bleeds -mx-4 / px-4 so the selected, chosen and pressed fill runs edge to
 * edge on phone, never boxed inside the 16 gutter. Selected: the panel-2 fill.
 * From 768: 12 + 48 + 12 = 72 (ROW_INSET, ROW_PICTURE, ROW_HEIGHT in ui/layout).
 * Under 768 (12 Nov 2026): 8 + 44 + 8 = 60 (ROW_INSET_PHONE, ROW_HEIGHT_PHONE):
 * the two 20 lines and their 4 fill the row, the 36 picture (ROW_PICTURE_PHONE)
 * hangs from the title line's top.
 */
export function listCardFrame(selected = false): string {
  return cn('relative -mx-4 flex h-15 min-w-0 px-4 py-2 md:h-18 md:py-3', selected && 'bg-panel-2');
}

/**
 * The inner row: picture then text, 12 apart (the frame carries the 16 side
 * padding). From 768 vertically centred; under 768 top-aligned, so the
 * picture's top is the title line's top (8 from the row top) on every row,
 * one line or more. No text selection, callout or magnifier on a hold (iOS
 * long-press selects).
 */
export const LIST_CARD_BODY =
  'pointer-events-none relative flex min-w-0 flex-1 items-start gap-3 md:items-center';

/**
 * The solid row's look: ink fill, accent-fg text, the laptop hover step, the
 * focus line in accent-fg (the ink line would not show on ink), no callout.
 * The seam: a 1px line in the page background (border-bg) on a box one pixel
 * up and left of the row, so it shows only where it lies over a neighbouring
 * solid row (above it on phone, left of it in the laptop grid) and never on
 * the page. Corners: a lone row rounds itself (md+); the rest is the group's.
 */
export const LIST_CARD_SOLID =
  'bg-accent text-accent-fg hover:bg-accent-hover [--sel-edge:rgb(var(--accent-fg-rgb))] before:pointer-events-none before:absolute before:-left-px before:-top-px before:bottom-0 before:right-0 before:border-l before:border-t before:border-bg md:only:rounded-lg xl:last:rounded-r-lg';

/** The solid row's picture tile: bg-panel with an fg icon (rounded-picture from the box). */
export const LIST_CARD_SOLID_TILE = 'bg-panel text-fg';

/**
 * The solid row's tile under 768: centred in the 60 row (12 above and below
 * the 36), not hung from the title line. A solid row is a button-like fill
 * with a centred count pill, so a tile 8 from the top and 16 from the bottom
 * would look dropped; centred it sits like the pill. From 768 the body
 * centres every picture, so this changes nothing there.
 */
export const LIST_CARD_SOLID_PICTURE = 'self-center';

/**
 * The count slot: the row's right edge, vertically centred in the row (its
 * own self-center: under 768 the body is top-aligned).
 */
export const LIST_CARD_COUNT = 'flex shrink-0 items-center self-center';

/** The picture box: 48 from 768 (ROW_PICTURE), 36 under it (ROW_PICTURE_PHONE); never shrinks. */
export const LIST_CARD_PICTURE =
  'relative flex h-9 w-9 shrink-0 items-center justify-center md:h-12 md:w-12';

/** The rounded-picture (10) squircle a non-person picture sits in; flat. */
const PICTURE_BOX = 'overflow-hidden rounded-picture';

/** The text column: two 20 lines, 4 apart (44). */
export const LIST_CARD_TEXT = 'flex min-w-0 flex-1 flex-col gap-1';

/** Line 1: title then the time on the right; one 20 line. */
export const LIST_CARD_LINE1 = 'flex h-5 min-w-0 items-center gap-2';

/**
 * Line 2: preview, the tag, the unread dot; one 20 line, always there. With no
 * preview the tag sits on the right end, under the time.
 */
export const LIST_CARD_LINE2 = 'flex h-5 min-w-0 items-center gap-2';

/** The preview: secondary role, one line, truncated. */
export const LIST_CARD_PREVIEW = textRole('secondary', 'min-w-0 flex-1 truncate');

/**
 * previewLines 2 (Activity): the row grows with its preview, never under the
 * row height; line 2 is two lines tall at least, so the row is 72 + 20 = 92
 * from 768 (44 for the preview line under the 20 title line and its 4 step)
 * and 60 + 20 = 80 under 768 (two 20 lines of the 15 preview: 8 + 20 + 4 + 40 + 8).
 */
export const LIST_CARD_FRAME_2 = 'h-auto min-h-15 md:h-auto md:min-h-18';
export const LIST_CARD_LINE2_2 = 'flex min-h-10 min-w-0 items-start gap-2 md:min-h-11';
// The secondary role's look without its truncate (a cut preview wraps; it never ellipsizes in CSS).
export const LIST_CARD_PREVIEW_2 = 'min-w-0 flex-1 break-words text-md font-normal text-fg-2';

/**
 * The tag's place on line 2 (11 Nov 2026): its own width while it fits, never
 * stretched; too long, it shrinks and the tag cuts with an ellipsis inside the
 * row, so the unread dot (shrink-0) keeps its place and nothing leaves the row.
 */
export const LIST_CARD_TAG = 'flex min-w-0 shrink';

/** The unread dot: 8px, round, fg ink. */
export const LIST_CARD_UNREAD_DOT = 'inline-block h-2 w-2 shrink-0 rounded-full bg-fg';

/**
 * Rows a card shows under itself (Activity's one line per notification) start on the
 * card's text column: the picture plus its 12 gap (48 + 12 = 60, ROW_TEXT_START;
 * 36 + 12 = 48 under 768, ROW_TEXT_START_PHONE).
 */
export const LIST_CARD_SUB_INSET = 'pl-12 md:pl-15';

/** The list the rows stack in: rows touching, no divider (phone, and the chat list pane). */
export const LIST_CARD_STACK = 'flex flex-col';

/**
 * The page list: one column on phone, auto-fill columns at least 360 wide on
 * laptop (grid-cols-list-cards); rows touching, 32 between laptop columns: the
 * rows' -mx-4 bleed (16 each side) meets exactly in the gap, so neighbouring
 * columns' fills and tap targets never overlap.
 * Pipeline, Briefs, Assets, Activity, the Plan tab and Bank; the chat list
 * stays LIST_CARD_STACK.
 */
export const LIST_CARD_GRID = 'grid grid-cols-1 md:grid-cols-list-cards md:gap-x-8';

/**
 * The group solid rows sit in (Activity's lead slot): LIST_CARD_GRID, so each
 * row is one grid cell lined up with the cards under it. It bleeds like the
 * rows (-mx-4 / px-4) and clips to its box: edge to edge on phone, the outer
 * corners rounded-lg at md+ (the cells touch; their seam is LIST_CARD_SOLID's).
 */
export const LIST_CARD_SOLID_GROUP = `${LIST_CARD_GRID} -mx-4 overflow-hidden px-4 md:rounded-lg`;

/**
 * The tap surface laid over the whole row: the hover / press fill edge to edge
 * and the focus line inside the edge. The row itself sinks (MOVE_CLASS.press
 * on the root), so the overlay carries no press of its own.
 */
export const LIST_CARD_COVER =
  'absolute inset-0 w-full text-left lit-hover focus-visible:lit-focus-inset disabled:pointer-events-none disabled:cursor-default';

/** No text selection, callout or magnifier on a long-press (iOS). */
export const LIST_CARD_NO_CALLOUT = 'select-none [-webkit-touch-callout:none]';

/**
 * The select tick: ui/SelectCheck at its 20 size on the picture's bottom-right
 * corner (the one select circle: same fill, border and tick as every list).
 * It scales in when select mode starts (mv-slide on transform; instant under
 * Reduce Motion) and never moves anything around it.
 */
export function listCardTickClass(active: boolean): string {
  return cn('absolute -bottom-1 -right-1', MOVE_CLASS.slide, active ? 'scale-100' : 'scale-0');
}

function Tick({ active, chosen }: { active: boolean; chosen: boolean }): ReactElement {
  return (
    <SelectCheck
      checked={active && chosen}
      size="sm"
      data-list-card-tick={active ? (chosen ? 'on' : 'off') : 'hidden'}
      className={listCardTickClass(active)}
    />
  );
}

function Picture({
  picture,
  hooks,
  select,
  solid,
}: {
  picture: ListCardPicture;
  hooks: ListCardHooks | undefined;
  select: ListCardSelect | undefined;
  solid: boolean;
}): ReactElement {
  const kind = picture.kind;
  return (
    <span
      data-list-card-picture={kind}
      {...hooks}
      className={cn(LIST_CARD_PICTURE, solid && LIST_CARD_SOLID_PICTURE)}
    >
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
            className={cn(
              'flex h-full w-full items-center justify-center',
              solid ? LIST_CARD_SOLID_TILE : 'bg-panel-2 text-fg-2',
            )}
          >
            <picture.icon size={ICON_SIZE.control} />
          </span>
        ) : (
          <PostPlaceholder kind={picture.placeholder} size={ICON_SIZE.control} fill />
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
 * The one list row (Pipeline, Briefs, Assets, the Chat list, Activity, the
 * Plan tab and Bank), flat Slack style (7 Nov 2026): no border, no radius, rows
 * touching with no divider, the whole row one tap target that sinks when
 * pressed. Left: the picture (48 centred from 768; 36 on the title line's top
 * under 768). Right, two lines:
 *   1. title (heading, bold unread, regular read, one line) ... time (meta,
 *      right, the bad token when late);
 *   2. preview (secondary, one line) then the one grey Tag then the unread dot;
 *      with no preview the tag sits on the right end, under the time.
 * No third line and no ⋮: a card's actions live on its list's select bar
 * (long-press / right-click selects). Every row is exactly ROW_HEIGHT from 768
 * and ROW_HEIGHT_PHONE under it (ui/layout); line 2 stays even when it is empty.
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
  previewLines = 1,
  tag,
  tagDot,
  tagHooks,
  unread = false,
  unreadDotHidden = false,
  select,
  onPress,
  press,
  pressRef,
  cover,
  disabled = false,
  selected = false,
  muted = false,
  solid = false,
  count,
  as: Root = 'div',
  rootRef,
  surface,
  ...rest
}: ListCardProps) {
  const tapped = onPress !== undefined || cover !== undefined;
  // A count takes the right edge: no time, tag or unread dot beside it.
  const counted = count !== undefined;
  const hasTag = !counted && tag !== undefined && tag !== '';
  const hasTime = !counted && time !== undefined && time !== '';
  const showUnread = unread && !counted;
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
      : [titleId, hasPreview ? previewId : null, showUnread ? unreadId : null]
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
      {...(previewLines === 2 ? { 'data-list-card-lines': '2' } : {})}
      {...(select !== undefined && select.active ? { 'data-list-card-selecting': '' } : {})}
      {...(solid ? { 'data-list-card-solid': '' } : {})}
      className={cn(
        listCardFrame(selected || chosen),
        previewLines === 2 && LIST_CARD_FRAME_2,
        (select !== undefined || solid) && LIST_CARD_NO_CALLOUT,
        solid && LIST_CARD_SOLID,
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
        <Picture picture={picture} hooks={pictureHooks} select={select} solid={solid} />
        <div className={LIST_CARD_TEXT}>
          <div data-list-card-line="1" className={LIST_CARD_LINE1}>
            <span
              id={titleId}
              data-list-card-title=""
              {...(tapped && !disabled ? { onClick: clickCover } : {})}
              className={textRole(
                'heading',
                cn(
                  'min-w-0 flex-1 truncate',
                  !unread && 'font-normal',
                  muted && 'text-fg-3',
                  solid && 'text-accent-fg',
                  tapped && !disabled && 'pointer-events-auto',
                ),
              )}
            >
              {title}
            </span>
            {hasTime ? (
              <span
                data-list-card-time=""
                {...(timeBad ? { 'data-list-card-time-bad': '' } : {})}
                {...timeHooks}
                className={textRole(
                  'meta',
                  cn('shrink-0 whitespace-nowrap', timeBad && 'text-bad'),
                )}
              >
                {time}
              </span>
            ) : null}
          </div>
          <div
            data-list-card-line="2"
            className={previewLines === 2 ? LIST_CARD_LINE2_2 : LIST_CARD_LINE2}
          >
            {hasPreview ? (
              <span
                id={previewId}
                data-list-card-preview=""
                {...previewHooks}
                className={cn(
                  previewLines === 2 ? LIST_CARD_PREVIEW_2 : LIST_CARD_PREVIEW,
                  solid && 'text-accent-fg',
                )}
              >
                {preview}
              </span>
            ) : null}
            {/* No preview: the spacer leads, so the tag sits on line 2's right
                end, right under the time (the unread dot after it). */}
            {!hasPreview ? <span data-list-card-spacer="" className="flex-1" /> : null}
            {hasTag ? (
              <span data-list-card-tag="" {...tagHooks} className={LIST_CARD_TAG}>
                <Tag
                  label={tag}
                  tone="neutral"
                  cut
                  {...(tagDot !== undefined ? { dot: tagDot } : {})}
                />
              </span>
            ) : null}
            {showUnread ? (
              <span
                id={unreadId}
                data-list-card-unread=""
                role="img"
                aria-label="Unread"
                className={unreadDotHidden ? 'sr-only' : LIST_CARD_UNREAD_DOT}
              />
            ) : null}
          </div>
        </div>
        {count !== undefined && count > 0 ? (
          <span data-list-card-count="" aria-hidden="true" className={LIST_CARD_COUNT}>
            <CountBadge count={count} {...(solid ? { tone: 'on-fill' as const } : {})} />
          </span>
        ) : null}
      </div>
    </Root>
  );
}

/**
 * A loading box in ListCard's own frame and slots (the picture, the title
 * line with its time, the preview line), the row height, so nothing moves
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
          className={cn(LIST_CARD_PICTURE, round ? 'rounded-lg' : PICTURE_BOX)}
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

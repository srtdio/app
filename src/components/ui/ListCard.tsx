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
import { ICON_SIZE, type IconProps } from '@/components/ui/icons';
import { SelectCheck } from '@/components/ui/SelectCheck';
import { useSelectGesture, type SelectGesture } from '@/components/ui/useLongPress';

/** data-* hooks (tests, the tour, scroll anchors). Behaviour only, never the look. */
export type ListCardHooks = { [hook: `data-${string}`]: string | undefined };

/**
 * The picture slot (48x48, 40x40 in Compact; left, vertically centred, 12 to the text):
 * - person: the person's photo, a rounded square (ui/Avatar 'card', 48 / 40; initials on their colour when none);
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
   * more, unfolded). The row grows by one line (density height + 20) and the
   * preview wraps instead of truncating; the caller cuts the text. Default 1:
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
 * Density (8 Nov 2026, <html data-density>): Cozy 12 + 48 + 12 = 72; Compact
 * 10 + 40 + 10 = 60 (py-row-inset, the one 10 token); Calm 16 + 48 + 16 = 80.
 */
export function listCardFrame(selected = false): string {
  return cn(
    'relative -mx-4 flex h-18 min-w-0 px-4 py-3 compact:h-15 compact:py-row-inset calm:h-20 calm:py-4',
    selected && 'bg-panel-2',
  );
}

/** The row height per density: picture + inset above and below. */
export const LIST_CARD_HEIGHT_BY_DENSITY = { compact: 60, cozy: 72, calm: 80 } as const;

/** The row picture per density (Avatar 'card' matches it). */
export const LIST_CARD_PICTURE_BY_DENSITY = { compact: 40, cozy: 48, calm: 48 } as const;

/**
 * The active density's row height (60 / 72 / 80): the given density, else the
 * one on <html data-density>, else Cozy. Sync, no read.
 */
export function listCardHeightPx(density?: string): number {
  const d =
    density ??
    (typeof document === 'undefined' ? undefined : document.documentElement.dataset.density);
  return d === 'compact' || d === 'calm'
    ? LIST_CARD_HEIGHT_BY_DENSITY[d]
    : LIST_CARD_HEIGHT_BY_DENSITY.cozy;
}

/**
 * The default (Cozy) row height. Use listCardHeightPx() for the active density.
 */
export const LIST_CARD_HEIGHT_PX = LIST_CARD_HEIGHT_BY_DENSITY.cozy;

/**
 * The inner row: picture then text, 12 apart, vertically centred (the frame
 * carries the 16 side padding). No text selection, callout or magnifier on a
 * hold (iOS long-press selects).
 */
export const LIST_CARD_BODY = 'pointer-events-none relative flex min-w-0 flex-1 items-center gap-3';

/** The picture box: 48 (Cozy, Calm) or 40 (Compact), never shrinks. */
export const LIST_CARD_PICTURE =
  'relative flex h-12 w-12 shrink-0 items-center justify-center compact:h-10 compact:w-10';

/** The rounded-picture (10) squircle a non-person picture sits in; flat. */
const PICTURE_BOX = 'overflow-hidden rounded-picture';

/** The text column: two 20 lines, 4 apart (44), every density. */
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
 * density height; line 2 is two lines tall at least, so the row is the
 * density height + 20 (Cozy 92, Compact 80, Calm 100): 44 / 36 / 44 for the
 * preview line under the 20 title line and its 4 step.
 */
export const LIST_CARD_FRAME_2 =
  'h-auto min-h-18 compact:h-auto compact:min-h-15 calm:h-auto calm:min-h-20';
export const LIST_CARD_LINE2_2 = 'flex min-h-11 min-w-0 items-start gap-2 compact:min-h-9';
// The secondary role's look without its truncate (a cut preview wraps; it never ellipsizes in CSS).
export const LIST_CARD_PREVIEW_2 = 'min-w-0 flex-1 break-words text-md font-normal text-fg-2';

/** The unread dot: 8px, round, fg ink. */
export const LIST_CARD_UNREAD_DOT = 'inline-block h-2 w-2 shrink-0 rounded-full bg-fg';

/**
 * Rows a card shows under itself (Activity's one line per notification) start on the
 * card's text column: the density picture plus its 12 gap (48 + 12 = 60 Cozy
 * and Calm, 40 + 12 = 52 Compact).
 */
export const LIST_CARD_SUB_INSET = 'pl-15 compact:pl-13';

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
 * pressed. Left: the 40 picture, vertically centred. Right, two lines:
 *   1. title (heading, bold unread, regular read, one line) ... time (meta,
 *      right, the bad token when late);
 *   2. preview (secondary, one line) then the one grey Tag then the unread dot;
 *      with no preview the tag sits on the right end, under the time.
 * No third line and no ⋮: a card's actions live on its list's select bar
 * (long-press / right-click selects). Every row is exactly the density height (listCardHeightPx); line 2 stays even when it
 * is empty.
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
      {...(previewLines === 2 ? { 'data-list-card-lines': '2' } : {})}
      {...(select !== undefined && select.active ? { 'data-list-card-selecting': '' } : {})}
      className={cn(
        listCardFrame(selected || chosen),
        previewLines === 2 && LIST_CARD_FRAME_2,
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
                cn(
                  'min-w-0 flex-1 truncate',
                  !unread && 'font-normal',
                  muted && 'text-fg-3',
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
                className={previewLines === 2 ? LIST_CARD_PREVIEW_2 : LIST_CARD_PREVIEW}
              >
                {preview}
              </span>
            ) : null}
            {/* No preview: the spacer leads, so the tag sits on line 2's right
                end, right under the time (the unread dot after it). */}
            {!hasPreview ? <span data-list-card-spacer="" className="flex-1" /> : null}
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
            {unread ? (
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
      </div>
    </Root>
  );
}

/**
 * A loading box in ListCard's own frame and slots (the density picture, the title
 * line with its time, the preview line), the density row height, so nothing moves
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

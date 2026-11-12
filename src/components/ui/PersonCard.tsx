// The one person card. Any person photo, name or @mention renders through
// ui/PersonTrigger, which opens this card; no screen builds its own. Phone: a
// bottom Sheet that sits on the keyboard. Laptop: a ~320px popover beside the
// tapped photo or name, closing on Esc or an outside click, with focus moving
// in and back to the trigger. The card paints in the tap's frame from what the
// trigger handed it plus the shared members cache (src/lib/workspace-members.ts):
// no network read before paint. A username or role not held yet keeps its
// line's height and fills in place.
//
// For anyone else it is the Instagram-style inline message: header (photo,
// full name, "@username · Role", X), the context line when the tap came from a
// comment or group chat message, and the inline composer (PersonMessageInput).
// A send closes the card at once, then queues through the outbox
// (use-person-message-send). Me keeps "Message yourself" (Personal notes); a
// removed member keeps "No longer in this workspace". A trigger with view
// 'photo' (inside a DM only) opens PhotoViewer instead.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactElement, ReactNode, Ref } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { ICON_SIZE, IconChat, IconChevronLeft } from '@/components/ui/icons';
import { LEADING_PULL } from '@/components/ui/layout';
import { PersonMessageInput } from '@/components/ui/PersonMessageInput';
import { PhotoViewer } from '@/components/ui/PhotoViewer';
import { Sheet } from '@/components/ui/Sheet';
import { useOpenPersonDm } from '@/components/ui/use-open-person-dm';
import { usePersonMessageSend } from '@/components/ui/use-person-message-send';
import { visibleViewportHeight } from '@/components/chat/MessageActionMenu';
import { personDraftKey, setDraft } from '@/lib/chat/drafts';
import { roleLabel } from '@/components/pages/settings/members-data';
import { cn } from '@/lib/cn';
import { isFormerMember, personAvatar, personName } from '@/lib/chat/mentions';
import { useDismissLayer } from '@/lib/modal-focus';
import { menuOrigin, popoverClass } from '@/components/ui/popover-classes';
import { growFromTrigger } from '@/lib/motion';
import {
  closePersonCard,
  personCardAction,
  personCardSnapshot,
  personContextLine,
  personFirstName,
  subscribePersonCard,
  type PersonCardAction,
  type PersonCardRequest,
} from '@/lib/person-card';
import { useSession } from '@/lib/session-context';
import { useIsLaptop, viewportSize } from '@/lib/use-is-laptop';
import { useWorkspace } from '@/lib/workspace-context';
import {
  currentMembers,
  keptWorkspaceMembers,
  useWorkspaceMembers,
  type WorkspaceMembersData,
} from '@/lib/workspace-members';

/** Approved copy (2 Nov 2026). The inline card's own copy lives in src/lib/person-card.ts. */
export const PERSON_CARD_COPY = {
  self: 'Message yourself',
  removed: 'No longer in this workspace',
  hint: 'Esc or click outside to close',
} as const;

/** The laptop popover's width and its gap from the tapped element. */
export const PERSON_POPOVER_W = 320;
const POPOVER_GAP = 8;
/** The popover's height used only to keep it inside the viewport. */
const POPOVER_EST_H = 236;
const EDGE = 8;

/** Where the laptop popover sits: right of the anchor when it fits, else left; clamped. Pure. */
export function personPopoverPosition(
  anchor: { top: number; left: number; right: number; bottom: number } | null,
  viewport: { width: number; height: number },
): { top: number; left: number } {
  if (anchor === null) {
    return {
      top: Math.max(EDGE, (viewport.height - POPOVER_EST_H) / 2),
      left: Math.max(EDGE, (viewport.width - PERSON_POPOVER_W) / 2),
    };
  }
  const fitsRight = anchor.right + POPOVER_GAP + PERSON_POPOVER_W + EDGE <= viewport.width;
  const left = fitsRight
    ? anchor.right + POPOVER_GAP
    : Math.max(EDGE, anchor.left - POPOVER_GAP - PERSON_POPOVER_W);
  const top = Math.min(
    Math.max(EDGE, anchor.top),
    Math.max(EDGE, viewport.height - POPOVER_EST_H - EDGE),
  );
  return { top, left };
}

/** What the card shows for one person. */
export interface PersonCardData {
  userId: string;
  name: string;
  avatarUrl: string | null;
  /** Null while not held: the line keeps its height. */
  username: string | null;
  /** The Members role label; null while not held. */
  role: string | null;
  action: PersonCardAction;
}

/**
 * The card's data from the trigger's hint, the members cache and the mention
 * registry; never reads. A person is removed when the trigger said so, the held
 * members list lacks them, or the registry marked them former. Pure.
 */
export function personCardData(input: {
  request: Pick<PersonCardRequest, 'userId' | 'name' | 'avatarUrl' | 'username' | 'former'>;
  me: string | null;
  workspaceId: string | null;
  members: Pick<WorkspaceMembersData, 'rows' | 'profiles'> | null;
}): PersonCardData {
  const { request, members, workspaceId } = input;
  const userId = request.userId;
  const profile = members?.profiles.get(userId);
  const row =
    members === null
      ? undefined
      : currentMembers(members.rows).find((r) => r.user_id.toLowerCase() === userId.toLowerCase());
  const removed =
    request.former === true ||
    (members !== null && members.rows.length > 0 && row === undefined) ||
    (members === null && isFormerMember(workspaceId, userId));
  const registryName = personName(workspaceId, userId);
  const name =
    profile?.displayName ??
    (request.name !== undefined && request.name !== null && request.name !== ''
      ? request.name
      : registryName !== undefined && !isFormerMember(workspaceId, userId)
        ? registryName
        : '');
  const username = profile?.username ?? request.username ?? null;
  return {
    userId,
    name,
    avatarUrl: profile?.avatarUrl ?? request.avatarUrl ?? personAvatar(workspaceId, userId),
    username: username !== null && username !== '' ? username : null,
    role: row !== undefined ? roleLabel(row.role) : null,
    action: personCardAction({ userId, me: input.me, removed }),
  };
}

/** "@username · Role", either half alone when the other is not held; '' when neither. Pure. */
export function personMetaLine(data: Pick<PersonCardData, 'username' | 'role'>): string {
  const parts: string[] = [];
  if (data.username !== null) parts.push(`@${data.username}`);
  if (data.role !== null) parts.push(data.role);
  return parts.join(' · ');
}

interface PersonCardBodyProps {
  data: PersonCardData;
  /** The name shows in the Sheet's title on phone; the popover shows it here. */
  showName: boolean;
  showHint: boolean;
  onAction: () => void;
  actionRef?: Ref<HTMLButtonElement>;
}

/**
 * Me and a removed member: the #765 card, unchanged (photo, name, meta, then
 * "Message yourself" or "No longer in this workspace").
 */
export function PersonCardBody({
  data,
  showName,
  showHint,
  onAction,
  actionRef,
}: PersonCardBodyProps): ReactElement {
  const meta = personMetaLine(data);
  return (
    <div className="flex flex-col items-center gap-3 text-center" data-person-card={data.userId}>
      <Avatar
        role="profile"
        name={data.name}
        {...(data.avatarUrl !== null ? { src: data.avatarUrl } : {})}
      />
      <div className="flex w-full min-w-0 flex-col items-center gap-1">
        {showName ? (
          <p className="w-full truncate text-lg font-semibold text-fg">{data.name}</p>
        ) : null}
        {/* Reserved line: an unheld username or role fills in place, no jump. */}
        <p className="h-5 w-full truncate py-1 text-sm text-fg-2" data-person-meta="">
          {meta}
        </p>
      </div>
      {data.action === 'removed' ? (
        // Flat look: the note sits on the sheet, no grey box (py-3 keeps the footprint).
        <p className="w-full px-4 py-3 text-base text-fg-2">{PERSON_CARD_COPY.removed}</p>
      ) : (
        <Button
          variant="primary"
          className="w-full md:w-auto"
          onClick={onAction}
          buttonRef={actionRef}
        >
          <IconChat size={ICON_SIZE.inline} />
          {PERSON_CARD_COPY.self}
        </Button>
      )}
      {showHint ? <p className="text-sm text-fg-3">{PERSON_CARD_COPY.hint}</p> : null}
    </div>
  );
}

interface PersonMessageCardProps {
  data: PersonCardData;
  /** The context line (personContextLine); null hides it. */
  context: string | null;
  /** The drafts key for this person and source. */
  draftKey: string;
  layout: 'touch' | 'laptop';
  /** The name and "<" back sit in the Sheet's own header on phone; the popover draws them here. */
  showHeader: boolean;
  onClose: () => void;
  onSend: (text: string) => void;
}

/**
 * The inline message card's content, shared by the phone Sheet and the laptop
 * popover: header, context line, inline composer.
 */
export function PersonMessageCard(props: PersonMessageCardProps): ReactElement {
  const { data } = props;
  const meta = personMetaLine(data);
  const photo = (
    <Avatar
      role="row"
      name={data.name}
      {...(data.avatarUrl !== null ? { src: data.avatarUrl } : {})}
    />
  );
  return (
    <div className="flex flex-col gap-3" data-person-card={data.userId} data-person-card-message="">
      <div className="flex min-w-0 items-center gap-3">
        {props.showHeader ? (
          // The one exit: "<" back leading, pulled out by 12 (LEADING_PULL).
          <IconButton
            type="button"
            label="Back"
            onClick={props.onClose}
            className={cn(LEADING_PULL, 'shrink-0')}
          >
            <IconChevronLeft size={ICON_SIZE.control} />
          </IconButton>
        ) : null}
        {photo}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {props.showHeader ? (
            <p className="truncate text-base font-medium text-fg">{data.name}</p>
          ) : null}
          {/* Reserved line: an unheld username or role fills in place, no jump.
              Under 768 it is the row's only line: its own 16 line box (no 4 pad
              pushing the words 2 under the photo's centre), so the words and
              the photo's initials share one centre line. */}
          <p
            className="h-5 truncate py-1 text-sm text-fg-2 max-md:h-4 max-md:py-0"
            data-person-meta=""
          >
            {meta}
          </p>
        </div>
      </div>
      {props.context !== null ? (
        <p className="truncate text-md text-fg-2" data-person-context="">
          {props.context}
        </p>
      ) : null}
      <PersonMessageInput
        firstName={personFirstName(data.name)}
        draftKey={props.draftKey}
        layout={props.layout}
        onSend={props.onSend}
      />
    </div>
  );
}

/**
 * Pixels the on-screen keyboard covers at the bottom of the layout viewport
 * (visualViewport), 0 without one. The phone card adds this under its
 * composer so the sheet sits on the keyboard: no gap, no page jump. Pure.
 */
export function keyboardInset(win: {
  innerHeight: number;
  visualViewport?: { height: number; offsetTop: number } | null;
}): number {
  return Math.max(0, Math.round(win.innerHeight - visibleViewportHeight(win)));
}

/** The keyboard inset, kept current on visualViewport resize and scroll while `on`. */
function useKeyboardInset(on: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!on || typeof window === 'undefined') return undefined;
    const vv = window.visualViewport;
    const measure = (): void => setInset(keyboardInset(window));
    measure();
    vv?.addEventListener('resize', measure);
    vv?.addEventListener('scroll', measure);
    return () => {
      vv?.removeEventListener('resize', measure);
      vv?.removeEventListener('scroll', measure);
    };
  }, [on]);
  return inset;
}

function useMeSafe(): string | null {
  try {
    return useSession().session?.user.id ?? null;
  } catch {
    return null;
  }
}

function useWorkspaceIdSafe(): string | null {
  try {
    return useWorkspace().workspaceId;
  } catch {
    return null;
  }
}

/**
 * Mounted once in the shell. Reads the open request and paints the card (or
 * the photo viewer) in the same frame; the members cache is subscribed only
 * while one is open.
 */
export function PersonCardHost(): ReactElement | null {
  const request = useSyncExternalStore(subscribePersonCard, personCardSnapshot, personCardSnapshot);
  const isLaptop = useIsLaptop();
  const me = useMeSafe();
  const workspaceId = useWorkspaceIdSafe();
  const openDm = useOpenPersonDm();
  const sendMessage = usePersonMessageSend();
  const members = useWorkspaceMembers(request !== null ? workspaceId : null);
  // Phone keeps the last request through the Sheet's exit slide.
  const [shown, setShown] = useState<PersonCardRequest | null>(request);
  useEffect(() => {
    if (request !== null) setShown(request);
  }, [request]);
  const active = request ?? shown;
  const keyboard = useKeyboardInset(!isLaptop && request !== null && request.view !== 'photo');

  const held: Pick<WorkspaceMembersData, 'rows' | 'profiles'> | null =
    !members.loading && members.error === null && members.rows.length > 0
      ? members
      : me !== null && workspaceId !== null
        ? (keptWorkspaceMembers(me, workspaceId) ?? null)
        : null;

  const close = useCallback((): void => closePersonCard(), []);

  if (active === null) return null;
  const data = personCardData({ request: active, me, workspaceId, members: held });

  if (active.view === 'photo') {
    return request !== null ? (
      <PhotoViewer
        userId={data.userId}
        name={data.name}
        avatarUrl={data.avatarUrl}
        trigger={request.trigger}
        onClose={close}
      />
    ) : null;
  }

  function onAction(): void {
    const userId = data.userId;
    // Close first, then navigate: the chat paints without the card over it.
    closePersonCard();
    openDm(userId);
  }

  const source = active.source ?? null;
  const draftKey = personDraftKey(data.userId, source);
  function onSend(text: string): void {
    const userId = data.userId;
    // The card closes before anything else runs: no network on the tap.
    closePersonCard();
    const giveBack = (back: string): void => setDraft(draftKey, { text: back, caret: back.length });
    const queued = sendMessage(
      { userId, firstName: personFirstName(data.name), text, source },
      giveBack,
    );
    if (!queued) giveBack(text);
  }

  const messaging = data.action === 'message';
  const content = (laptop: boolean): ReactNode =>
    messaging ? (
      <PersonMessageCard
        // Another person or source is another draft: remount, never carry text across.
        key={draftKey}
        data={data}
        context={personContextLine(source)}
        draftKey={draftKey}
        layout={laptop ? 'laptop' : 'touch'}
        showHeader={laptop}
        onClose={close}
        onSend={onSend}
      />
    ) : (
      <PersonCardBody data={data} showName={laptop} showHint={laptop} onAction={onAction} />
    );

  if (isLaptop) {
    return request !== null ? (
      <PersonPopover request={request} data={data} onClose={close} focusAction={!messaging}>
        {content(true)}
      </PersonPopover>
    ) : null;
  }
  return (
    <Sheet open={request !== null} onClose={close} title={data.name}>
      {content(false)}
      {messaging && keyboard > 0 ? (
        // Under the composer, behind the keyboard: the sheet rides on top of it.
        <div
          aria-hidden="true"
          data-person-keyboard=""
          style={{ height: `max(0px, calc(${keyboard}px + 8px - env(safe-area-inset-bottom)))` }}
        />
      ) : null}
    </Sheet>
  );
}

function PersonPopover({
  request,
  data,
  onClose,
  focusAction,
  children,
}: {
  request: PersonCardRequest;
  data: PersonCardData;
  onClose: () => void;
  /** Me and removed: focus the card's button (the message card focuses its own input). */
  focusAction: boolean;
  children: ReactNode;
}): ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);
  useDismissLayer(true, onClose, panelRef);

  // Rendered in place; on the first frame the card grows from the tapped
  // name or photo (growFromTrigger, scale only, never a fade).
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const a = request.anchor;
    const point = a !== null ? { x: (a.left + a.right) / 2, y: (a.top + a.bottom) / 2 } : null;
    growFromTrigger(panel, menuOrigin(panel, point));
  }, [request]);

  useEffect(() => {
    const panel = panelRef.current;
    // Focus moves into the card unless something in it already took it (the input).
    if (panel !== null && !panel.contains(document.activeElement)) {
      const button = focusAction ? panel.querySelector<HTMLButtonElement>('button') : null;
      (button ?? panel).focus({ preventScroll: true });
    }
    const trigger = request.trigger;
    return () => {
      // Hand focus back to the trigger when the card still held it.
      const activeEl = document.activeElement;
      const held =
        activeEl === null ||
        activeEl === document.body ||
        (panelRef.current?.contains(activeEl) ?? false);
      if (held && trigger !== null && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [request, focusAction]);

  // Scroll or resize moves the anchor away: close rather than float off it.
  useEffect(() => {
    window.addEventListener('resize', onClose);
    return () => window.removeEventListener('resize', onClose);
  }, [onClose]);

  const pos = personPopoverPosition(request.anchor, viewportSize());
  return createPortal(
    <>
      <div className="fixed inset-0 z-dock" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-label={data.name}
        tabIndex={-1}
        style={{ top: pos.top, left: pos.left, width: PERSON_POPOVER_W }}
        className={cn('fixed z-sheet p-4 focus:outline-none', popoverClass())}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

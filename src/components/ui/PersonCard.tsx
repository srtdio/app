// The one person card. Any person photo, name or @mention renders through
// ui/PersonTrigger, which opens this card; no screen builds its own. Phone: a
// bottom Sheet. Laptop: a small popover beside the tapped photo or name,
// closing on Esc or an outside click, with focus moving in and back to the
// trigger. The card paints in the tap's frame from what the trigger handed it
// plus the shared members cache (src/lib/workspace-members.ts): no network
// read before paint. A username or role not held yet keeps its line's height
// and fills in place.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement, Ref } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ICON_SIZE, IconChat } from '@/components/ui/icons';
import { Sheet } from '@/components/ui/Sheet';
import { useOpenPersonDm } from '@/components/ui/use-open-person-dm';
import { roleLabel } from '@/components/pages/settings/members-data';
import { cn } from '@/lib/cn';
import { isFormerMember, personAvatar, personName } from '@/lib/chat/mentions';
import { useDismissLayer } from '@/lib/modal-focus';
import { popoverClass } from '@/components/ui/popover-classes';
import {
  closePersonCard,
  personCardAction,
  personCardSnapshot,
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

/** Approved copy (2 Nov 2026). */
export const PERSON_CARD_COPY = {
  message: 'Message',
  self: 'Message yourself',
  removed: 'No longer in this workspace',
  hint: 'Esc or click outside to close',
} as const;

/** The laptop popover's width and its gap from the tapped element. */
export const PERSON_POPOVER_W = 280;
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

/** The card's content, shared by the phone Sheet and the laptop popover. */
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
      <Avatar role="profile" name={data.name} {...(data.avatarUrl !== null ? { src: data.avatarUrl } : {})} />
      <div className="flex w-full min-w-0 flex-col items-center gap-0.5">
        {showName ? (
          <p className="w-full truncate text-lg font-semibold text-fg">{data.name}</p>
        ) : null}
        {/* Reserved line: an unheld username or role fills in place, no jump. */}
        <p className="h-5 w-full truncate text-sm leading-5 text-fg-2" data-person-meta="">
          {meta}
        </p>
      </div>
      {data.action === 'removed' ? (
        <p className="w-full rounded-lg bg-panel-2 px-4 py-3 text-base text-fg-2">
          {PERSON_CARD_COPY.removed}
        </p>
      ) : (
        <Button variant="primary" className="w-full" onClick={onAction} buttonRef={actionRef}>
          <IconChat size={ICON_SIZE.inline} />
          {data.action === 'self' ? PERSON_CARD_COPY.self : PERSON_CARD_COPY.message}
        </Button>
      )}
      {showHint ? <p className="text-sm text-fg-3">{PERSON_CARD_COPY.hint}</p> : null}
    </div>
  );
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
 * Mounted once in the shell. Reads the open request and paints the card in the
 * same frame; the members cache is subscribed only while a card is open.
 */
export function PersonCardHost(): ReactElement | null {
  const request = useSyncExternalStore(subscribePersonCard, personCardSnapshot, personCardSnapshot);
  const isLaptop = useIsLaptop();
  const me = useMeSafe();
  const workspaceId = useWorkspaceIdSafe();
  const openDm = useOpenPersonDm();
  const members = useWorkspaceMembers(request !== null ? workspaceId : null);
  // Phone keeps the last request through the Sheet's exit slide.
  const [shown, setShown] = useState<PersonCardRequest | null>(request);
  useEffect(() => {
    if (request !== null) setShown(request);
  }, [request]);
  const active = request ?? shown;

  const held: Pick<WorkspaceMembersData, 'rows' | 'profiles'> | null =
    !members.loading && members.error === null && members.rows.length > 0
      ? members
      : me !== null && workspaceId !== null
        ? (keptWorkspaceMembers(me, workspaceId) ?? null)
        : null;

  const close = useCallback((): void => closePersonCard(), []);

  if (active === null) return null;
  const data = personCardData({ request: active, me, workspaceId, members: held });

  function onAction(): void {
    const userId = data.userId;
    // Close first, then navigate: the chat paints without the card over it.
    closePersonCard();
    openDm(userId);
  }

  if (isLaptop) {
    return request !== null ? (
      <PersonPopover request={request} data={data} onClose={close} onAction={onAction} />
    ) : null;
  }
  return (
    <Sheet open={request !== null} onClose={close} title={data.name}>
      <PersonCardBody data={data} showName={false} showHint={false} onAction={onAction} />
    </Sheet>
  );
}

function PersonPopover({
  request,
  data,
  onClose,
  onAction,
}: {
  request: PersonCardRequest;
  data: PersonCardData;
  onClose: () => void;
  onAction: () => void;
}): ReactElement {
  const panelRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const [entered, setEntered] = useState(false);
  useDismissLayer(true, onClose, panelRef);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true));
    // Focus moves into the card: the button, else the card itself.
    (actionRef.current ?? panelRef.current)?.focus({ preventScroll: true });
    const trigger = request.trigger;
    return () => {
      cancelAnimationFrame(raf);
      // Hand focus back to the trigger when the card still held it.
      const activeEl = document.activeElement;
      const held =
        activeEl === null ||
        activeEl === document.body ||
        (panelRef.current?.contains(activeEl) ?? false);
      if (held && trigger !== null && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [request]);

  // Scroll or resize moves the anchor away: close rather than float off it.
  useEffect(() => {
    window.addEventListener('resize', onClose);
    return () => window.removeEventListener('resize', onClose);
  }, [onClose]);

  const pos = personPopoverPosition(request.anchor, viewportSize());
  return createPortal(
    <>
      <div className="fixed inset-0 z-40" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-label={data.name}
        tabIndex={-1}
        style={{ top: pos.top, left: pos.left, width: PERSON_POPOVER_W }}
        className={cn('fixed z-50 p-4 focus:outline-none', popoverClass(entered))}
      >
        <PersonCardBody
          data={data}
          showName
          showHint
          onAction={onAction}
          actionRef={actionRef}
        />
      </div>
    </>,
    document.body,
  );
}

// The thread's reading layer: the unread divider and the jump pill, the
// scroll-to-latest button, the DM "Seen" line, the group "Read by" line and
// its Message info sheet, and the who-reacted sheet. Every element renders only
// once its data is in (nothing appears and then moves or goes on first paint).
// The floating surfaces (jump pill, scroll-to-latest) are the solid panel with a
// hairline: no backdrop-filter, which WebKit fails to paint over the thread's
// scroll container on iPhone (the message area stayed unpainted). Counts and
// times are JetBrains Mono. Motion (docs/motion.md): the pill and the button
// show at once and pop from .9 (ease-pop) as they appear, never a fade; the
// sheets rise (the shared Sheet). Tokens only, light and dark at parity.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement, RefObject } from 'react';
import { pop } from '@/lib/motion';
import type { Result } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Avatar } from '@/components/ui/Avatar';
import { PersonTrigger } from '@/components/ui/PersonTrigger';
import { CountBadge } from '@/components/ui/CountBadge';
import { PressableRow } from '@/components/ui/PressableRow';
import { ICON_SIZE, IconArrowUp, IconChevronDown } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { LANE_BOTTOM, LANE_TOP } from '@/components/ui/layout';
import { civilDay, formatAgo, formatTime } from '@/lib/time';
import { dayPillLabel } from '@/components/chat/day-separators';
import { BUBBLE_META_TYPE, EMOJI_PICK_TYPE, NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { RailThrough } from '@/components/chat/ThreadRail';
import { FORMER_MEMBER, type MentionMember } from '@/lib/chat/mentions';
import type { ChatProfile } from '@/lib/chat-reads';
import type { ReactorRow } from '@/lib/chat/history';
import { unreadLabel, type ReadPosition } from '@/lib/chat/read-receipts';
import {
  ALL_TAB,
  groupReactors,
  loadWhoReacted,
  rowsForTab,
  type WhoReacted,
} from '@/lib/chat/reactors';
import { useHistoryStep } from '@/lib/chat/use-history-step';
import { SHEET_STEP_KEYS } from '@/lib/chat/sheet-steps';
import { TEXT_ROLE } from '@/components/ui/Text';

/** A sheet read that failed or timed out. */
const SHEET_LOAD_FAILED = "Couldn't load";

/**
 * The floating surface for the jump pill and the scroll-to-latest button: the
 * solid panel token with a 1px hairline, the same in light and dark. Never a
 * backdrop-filter. On iOS WebKit a blurred layer over the thread's overflow
 * scroll container left the message area unpainted, showing stale composer
 * tiles.
 */
const FLOAT_SURFACE_CLASS = 'border border-border bg-panel';

/** Pop the element in (from .9, ease-pop) when `visible` turns true after mount. */
function usePopIn<T extends HTMLElement>(visible: boolean): RefObject<T> {
  const ref = useRef<T>(null);
  const was = useRef(visible);
  useLayoutEffect(() => {
    if (visible && !was.current) pop(ref.current);
    was.current = visible;
  }, [visible]);
  return ref;
}

/** The "New" line above the first unread message: thick ink rule + ink "New" pill (L7). */
export function UnreadDivider({ count }: { count: number }): ReactElement {
  // L7 (8 Nov 2026): a thick ink line and an ink "New" pill on the right
  // (replaces "N unread"); the main chat and the thread screen share it.
  return (
    <li
      role="separator"
      aria-label={`New, ${unreadLabel(count)}`}
      data-unread-divider=""
      data-new-line=""
      className={cn('flex items-center gap-2 px-4 pb-1 pt-3', NO_TOUCH_SELECT)}
    >
      <span aria-hidden="true" data-new-rule="" className="h-0.5 flex-1 bg-fg" />
      <span
        aria-hidden="true"
        data-new-pill=""
        className="flex h-5 shrink-0 items-center rounded-full bg-fg px-2 text-xs font-semibold text-bg"
      >
        New
      </span>
    </li>
  );
}

/** The floating jump-to-first-unread pill, top centre of the thread (solid panel). */
export function UnreadPill(props: {
  count: number;
  visible: boolean;
  onJump: () => void;
}): ReactElement {
  const popRef = usePopIn<HTMLSpanElement>(props.visible);
  return (
    // Shown or hidden at once on the wrapper; the pill pops as it appears.
    <div
      // Its own lane (ui/layout LANE_TOP): top centre, clear of the latest
      // button's and the tip strip's lanes.
      data-lane="top"
      className={cn(LANE_TOP, props.visible ? 'opacity-100' : 'opacity-0')}
    >
      <span ref={popRef} className="flex">
        <Button
          variant="ghost"
          type="button"
          data-unread-pill=""
          aria-label={`Jump to first unread, ${unreadLabel(props.count)}`}
          aria-hidden={!props.visible}
          tabIndex={props.visible ? 0 : -1}
          onClick={props.onJump}
          onContextMenu={(e) => e.preventDefault()}
          // A floating layer over the thread, not an in-content Button level:
          // the solid float surface (the latest button's), fg ink, the ghost's
          // hover overlay. Never the see-through grey.
          className={cn(
            'lit-float text-fg',
            FLOAT_SURFACE_CLASS,
            NO_TOUCH_SELECT,
            props.visible && 'pointer-events-auto',
          )}
        >
          <IconArrowUp size={ICON_SIZE.inline} className="text-accent" />
          <span className="font-mono tabular-nums text-accent">{props.count}</span>
          <span>unread</span>
        </Button>
      </span>
    </div>
  );
}

/** The round scroll-to-latest button, bottom-right, with the new-message badge (solid panel). */
export function LatestButton(props: {
  visible: boolean;
  count: number;
  onTap: () => void;
}): ReactElement {
  const popRef = usePopIn<HTMLSpanElement>(props.visible);
  return (
    // Position and visibility sit on the wrapper (shown at once); it pops as it appears.
    <span
      ref={popRef}
      // Its own lane (ui/layout LANE_BOTTOM): trailing edge, above the composer.
      data-lane="bottom"
      className={cn(LANE_BOTTOM, props.visible ? 'opacity-100' : 'pointer-events-none opacity-0')}
    >
      <IconButton
        type="button"
        data-latest-button=""
        label={props.count > 0 ? `Scroll to latest, ${props.count} new` : 'Scroll to latest'}
        aria-hidden={!props.visible}
        tabIndex={props.visible ? 0 : -1}
        onClick={props.onTap}
        onContextMenu={(e) => e.preventDefault()}
        className={cn('lit-float', FLOAT_SURFACE_CLASS, NO_TOUCH_SELECT)}
      >
        <IconChevronDown size={ICON_SIZE.nav} />
        <CountBadge count={props.count} className="absolute -right-1 -top-1" />
      </IconButton>
    </span>
  );
}

/**
 * "Seen <time>" under the last own message the DM peer has read; the time is
 * when they read it (read_at), and with none known the line reads "Seen"
 * alone. `rail`: a card thread's rail runs on past it (its through line at the left).
 */
export function SeenLine(props: {
  readAt: string | null;
  /** For tests: the zone times render in. The app passes none (the viewer's device zone). */
  timeZone?: string | undefined;
  rail?: boolean;
}): ReactElement {
  return (
    <li
      data-seen-line=""
      className={cn(
        // L1: left-aligned under the last own message's text (photo 32 + gap 8).
        'flex justify-start pl-14 pr-4 pt-1',
        props.rail === true && 'relative',
        NO_TOUCH_SELECT,
      )}
    >
      {props.rail === true ? <RailThrough /> : null}
      <span className={cn(BUBBLE_META_TYPE, 'text-fg-3')}>
        Seen
        {props.readAt !== null ? (
          <>
            {' '}
            <span className="font-sans tabular-nums">
              {formatTime(props.readAt, props.timeZone)}
            </span>
          </>
        ) : null}
      </span>
    </li>
  );
}

/**
 * "Read by X of Y" (or "Read by all") under the last own group message; a 44px
 * button. `rail`: a card thread's rail runs on past it.
 */
export function ReadByLine(props: {
  label: string;
  onOpen: () => void;
  rail?: boolean;
}): ReactElement {
  return (
    <li
      data-read-by-line=""
      className={cn(
        'flex justify-start pl-12 pr-2',
        props.rail === true && 'relative',
        NO_TOUCH_SELECT,
      )}
    >
      {props.rail === true ? <RailThrough /> : null}
      <PressableRow
        inline
        type="button"
        onClick={props.onOpen}
        onContextMenu={(e) => e.preventDefault()}
        aria-haspopup="dialog"
        className={cn(BUBBLE_META_TYPE, 'flex h-11 items-center px-2 text-fg-3 hover:text-fg-2')}
      >
        {readByWithMono(props.label)}
      </PressableRow>
    </li>
  );
}

/** The numbers of a Read by label in mono. */
function readByWithMono(label: string): ReactElement {
  const parts = label.split(/(\d+)/);
  return (
    <span>
      {parts.map((part, i) =>
        /^\d+$/.test(part) ? (
          <span key={`part-${i}`} className="font-mono">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </span>
  );
}

/** A list row's avatar (the shared Avatar, row role): the photo, else initials. */
function SheetAvatar(props: { name: string; src: string | null; dimmed?: boolean }): ReactElement {
  return (
    <span aria-hidden="true" className={cn('flex shrink-0', props.dimmed === true && 'opacity-50')}>
      <Avatar
        role="row"
        name={props.name}
        {...(props.src !== null && props.src !== '' ? { src: props.src } : {})}
      />
    </span>
  );
}

/** "Sent Today at 2:05 PM" for the Message info sheet. `timeZone` is for tests. Pure. */
export function sentLine(createdAt: string, timeZone: string | undefined, nowMs: number): string {
  const ms = Date.parse(createdAt);
  if (Number.isNaN(ms)) return '';
  const day = dayPillLabel(civilDay(ms, timeZone), nowMs, timeZone);
  return `Sent ${day} at ${formatTime(ms, timeZone)}`;
}

/** The group Message info sheet: who has read the message and who has not. */
export function MessageInfoSheet(props: {
  open: boolean;
  onClose: () => void;
  createdAt: string;
  /** For tests: the zone times render in. The app passes none (the viewer's device zone). */
  timeZone?: string | undefined;
  /** Server time now, for the Today / Yesterday label. */
  nowMs: number;
  read: readonly ReadPosition[];
  unread: readonly string[];
  members: readonly MentionMember[];
}): ReactElement {
  const byId = new Map(props.members.map((m) => [m.userId, m] as const));
  const nameOf = (id: string): string => {
    const name = byId.get(id)?.displayName;
    // Everyone listed is a current channel member: a name not loaded yet renders nothing.
    return name ?? '';
  };
  return (
    <Sheet open={props.open} onClose={props.onClose} title="Message info">
      <div className={cn('flex flex-col', NO_TOUCH_SELECT)} data-message-info="">
        <p className="pb-3 text-base text-fg-2">
          {sentLine(props.createdAt, props.timeZone, props.nowMs)}
        </p>
        <h3 className={`py-2 ${TEXT_ROLE.section}`}>
          Read by <span className="font-mono">{props.read.length}</span>
        </h3>
        <ul>
          {props.read.map((pos) => (
            <li key={pos.userId} className="flex min-h-14 items-center gap-3 py-1">
              <PersonTrigger
                userId={pos.userId}
                name={nameOf(pos.userId)}
                avatarUrl={byId.get(pos.userId)?.avatarUrl ?? null}
                display="block"
              >
                <SheetAvatar
                  name={nameOf(pos.userId)}
                  src={byId.get(pos.userId)?.avatarUrl ?? null}
                />
              </PersonTrigger>
              <span className="min-w-0 flex-1 truncate text-base text-fg">
                <PersonTrigger
                  userId={pos.userId}
                  name={nameOf(pos.userId)}
                  avatarUrl={byId.get(pos.userId)?.avatarUrl ?? null}
                >
                  {nameOf(pos.userId)}
                </PersonTrigger>
              </span>
              {pos.readAt !== null ? (
                <span className="font-mono text-sm tabular-nums text-fg-3">
                  {formatAgo(pos.readAt, new Date(props.nowMs), props.timeZone)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="my-2 h-px bg-border" aria-hidden="true" />
        <h3 className={`py-2 ${TEXT_ROLE.section}`}>
          Not read yet <span className="font-mono">{props.unread.length}</span>
        </h3>
        <ul>
          {props.unread.map((id) => (
            <li key={id} className="flex min-h-14 items-center gap-3 py-1">
              <PersonTrigger
                userId={id}
                name={nameOf(id)}
                avatarUrl={byId.get(id)?.avatarUrl ?? null}
                display="block"
              >
                <SheetAvatar name={nameOf(id)} src={byId.get(id)?.avatarUrl ?? null} dimmed />
              </PersonTrigger>
              <span className="min-w-0 flex-1 truncate text-base text-fg-3">
                <PersonTrigger
                  userId={id}
                  name={nameOf(id)}
                  avatarUrl={byId.get(id)?.avatarUrl ?? null}
                >
                  {nameOf(id)}
                </PersonTrigger>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
}

/** The who-reacted read: rows plus profiles for the reactors it had to name. */
export type WhoReactedLoad = (messageId: string) => Promise<
  Result<{
    rows: ReactorRow[];
    profiles: Map<string, ChatProfile>;
    /** Reactors a successful read confirmed are not current members; absent: none known. */
    former?: ReadonlySet<string>;
  }>
>;

/** The default reader: one select plus one batched profile read, 5s. */
export function defaultWhoReactedLoad(
  workspaceId: string | null,
  known: (userId: string) => ChatProfile | undefined,
): WhoReactedLoad {
  return (messageId) => loadWhoReacted(supabase, { messageId, workspaceId, known });
}

/** The who-reacted sheet: chips (All, then one per emoji) and one row per reaction. */
export function WhoReactedSheet(props: {
  messageId: string | null;
  onClose: () => void;
  viewerId: string | null;
  load: WhoReactedLoad;
  /** Remove the viewer's reaction (the existing reaction remove path). */
  onRemove: (messageId: string, emoji: string) => void;
}): ReactElement {
  const { messageId, viewerId } = props;
  // System Back closes only this sheet; the chat under it stays.
  useHistoryStep(messageId !== null, SHEET_STEP_KEYS.whoReacted, props.onClose);
  // The reader is read through a ref: a new function identity never reloads an open sheet.
  const loadRef = useRef(props.load);
  loadRef.current = props.load;
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; model: WhoReacted }
  >({ kind: 'loading' });
  const [tab, setTab] = useState(ALL_TAB);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    if (messageId === null) return;
    let cancelled = false;
    setState({ kind: 'loading' });
    setTab(ALL_TAB);
    void loadRef.current(messageId).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setState({ kind: 'failed' });
        return;
      }
      const { profiles } = result.data;
      const former = result.data.former ?? new Set<string>();
      setState({
        kind: 'ready',
        model: groupReactors(
          result.data.rows,
          viewerId,
          (id) => profiles.get(id),
          (id) => former.has(id),
        ),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [messageId, viewerId, attempt]);
  const model = state.kind === 'ready' ? state.model : null;
  const rows = model !== null ? rowsForTab(model, tab) : [];
  return (
    <Sheet open={messageId !== null} onClose={props.onClose} title="Reactions">
      <div className={cn('flex flex-col', NO_TOUCH_SELECT)} data-who-reacted="">
        {state.kind === 'failed' ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <p className="text-base text-fg-2">{SHEET_LOAD_FAILED}</p>
            <Button variant="ghost" className="min-w-11" onClick={retry}>
              Retry
            </Button>
          </div>
        ) : model === null ? null : (
          <>
            <div role="tablist" aria-label="Reactions" className="flex flex-wrap gap-2 pb-3">
              {model.tabs.map((t) => (
                <PressableRow
                  key={t.key}
                  inline
                  data-selected={tab === t.key ? 'true' : undefined}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  data-reactor-tab={t.key}
                  onClick={() => setTab(t.key)}
                  className={cn(
                    'flex items-center gap-2 px-4 text-base font-medium',
                    tab === t.key ? 'border border-fg text-fg' : 'border border-border text-fg-2',
                  )}
                >
                  <span>{t.emoji ?? 'All'}</span>
                  <span className="font-mono tabular-nums">{t.count}</span>
                </PressableRow>
              ))}
            </div>
            <ul>
              {rows.map((row, i) => {
                // Another person's photo and name open the person card; my own
                // row stays the one "tap to remove" button.
                const asPerson = (node: ReactElement, display: 'inline' | 'block'): ReactElement =>
                  row.mine ? (
                    node
                  ) : (
                    <PersonTrigger
                      userId={row.userId}
                      name={row.name}
                      avatarUrl={row.avatarUrl}
                      former={row.name === FORMER_MEMBER}
                      display={display}
                    >
                      {node}
                    </PersonTrigger>
                  );
                const body = (
                  <>
                    {asPerson(<SheetAvatar name={row.name} src={row.avatarUrl} />, 'block')}
                    <span className="flex min-w-0 flex-1 flex-col text-left">
                      <span className="truncate text-base text-fg">
                        {asPerson(<>{row.name}</>, 'inline')}
                      </span>
                      {row.mine ? <span className="text-sm text-fg-3">Tap to remove</span> : null}
                    </span>
                    <span aria-hidden="true" className={EMOJI_PICK_TYPE}>
                      {row.emoji}
                    </span>
                  </>
                );
                return (
                  <li key={`${row.userId}-${row.emoji}-${i}`} data-reactor-row={row.userId}>
                    {row.mine && messageId !== null ? (
                      <PressableRow
                        type="button"
                        data-reactor-remove=""
                        aria-label={`Remove your ${row.emoji} reaction`}
                        onClick={() => {
                          props.onRemove(messageId, row.emoji);
                          props.onClose();
                        }}
                        className="flex h-14 items-center gap-3 py-1"
                      >
                        {body}
                      </PressableRow>
                    ) : (
                      <div className="flex min-h-14 items-center gap-3 py-1">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </Sheet>
  );
}

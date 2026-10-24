// The thread's reading layer: the unread divider and the jump pill, the
// scroll-to-latest button, the DM "Seen" line, the group "Read by" line and
// its Message info sheet, and the who-reacted sheet. Every element renders only
// once its data is in (nothing appears and then moves or goes on first paint).
// The floating surfaces (jump pill, scroll-to-latest) are the solid panel with a
// hairline: no backdrop-filter, which WebKit fails to paint over the thread's
// scroll container on iPhone (the message area stayed unpainted). Counts and
// times are JetBrains Mono. Motion: pill and button opacity only; the sheets
// slide on translateY (the shared Sheet). Tokens only, light and dark at parity.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { Result } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import { ICON_SIZE, IconArrowUp, IconChevronDown } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { formatClockTime, civilDay } from '@/lib/chat/time-format';
import { dayPillLabel } from '@/components/chat/day-separators';
import { BUBBLE_META_TYPE, NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { RailThrough } from '@/components/chat/ThreadRail';
import type { MentionMember } from '@/lib/chat/mentions';
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

/** A sheet read that failed or timed out. */
export const SHEET_LOAD_FAILED = "Couldn't load";

/**
 * The floating surface for the jump pill and the scroll-to-latest button: the
 * solid panel token with a 1px hairline, the same in light and dark. Never a
 * backdrop-filter. On iOS WebKit a blurred layer over the thread's overflow
 * scroll container left the message area unpainted, showing stale composer
 * tiles.
 */
export const FLOAT_SURFACE_CLASS = 'border border-border bg-panel';

/** Opacity-only fade for the pill and the latest button. */
const FADE = 'transition-opacity duration-[160ms] motion-reduce:transition-none';

/** The unread divider row above the first unread message: hairline + "N unread". */
export function UnreadDivider({ count }: { count: number }): ReactElement {
  return (
    <li
      role="separator"
      aria-label={unreadLabel(count)}
      data-unread-divider=""
      className={cn('flex items-center gap-3 px-4 pb-1 pt-3', NO_TOUCH_SELECT)}
    >
      <span aria-hidden="true" className="h-px flex-1 bg-accent-line" />
      <span className="text-sm font-medium text-accent">
        <span className="font-mono tabular-nums">{count}</span> unread
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-accent-line" />
    </li>
  );
}

/** The floating jump-to-first-unread pill, top centre of the thread (solid panel). */
export function UnreadPill(props: {
  count: number;
  visible: boolean;
  onJump: () => void;
}): ReactElement {
  return (
    // The fade sits on the wrapper: Button's own transition would replace it.
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center',
        FADE,
        props.visible ? 'opacity-100' : 'opacity-0',
      )}
    >
      <Button
        variant="secondary"
        type="button"
        data-unread-pill=""
        aria-label={`Jump to first unread, ${unreadLabel(props.count)}`}
        aria-hidden={!props.visible}
        tabIndex={props.visible ? 0 : -1}
        onClick={props.onJump}
        onContextMenu={(e) => e.preventDefault()}
        // Secondary is the float surface (bg-panel, border-border, text-fg).
        className={cn(
          'shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          NO_TOUCH_SELECT,
          props.visible && 'pointer-events-auto',
        )}
      >
        <IconArrowUp size={ICON_SIZE.inline} className="text-accent" />
        <span className="font-mono tabular-nums text-accent">{props.count}</span>
        <span>unread</span>
      </Button>
    </div>
  );
}

/** The round scroll-to-latest button, bottom-right, with the new-message badge (solid panel). */
export function LatestButton(props: {
  visible: boolean;
  count: number;
  onTap: () => void;
}): ReactElement {
  return (
    // Position and fade sit on the wrapper: IconButton's own transition would
    // replace the opacity fade.
    <span
      className={cn(
        'absolute bottom-3 right-3 z-10 flex',
        FADE,
        props.visible ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      <IconButton
        type="button"
        data-latest-button=""
        label={props.count > 0 ? `Scroll to latest, ${props.count} new` : 'Scroll to latest'}
        aria-hidden={!props.visible}
        tabIndex={props.visible ? 0 : -1}
        onClick={props.onTap}
        onContextMenu={(e) => e.preventDefault()}
        className={cn(
          'shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          FLOAT_SURFACE_CLASS,
          NO_TOUCH_SELECT,
        )}
      >
        <IconChevronDown size={ICON_SIZE.control} />
        {props.count > 0 ? (
          <span
            data-latest-count=""
            className="absolute -top-1 -right-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-accent px-1 font-mono text-xs leading-none tabular-nums text-accent-fg"
          >
            {props.count}
          </span>
        ) : null}
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
  timeZone: string;
  rail?: boolean;
}): ReactElement {
  return (
    <li
      data-seen-line=""
      className={cn(
        'flex justify-end px-4 pt-0.5',
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
              {formatClockTime(props.readAt, props.timeZone)}
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
      className={cn('flex justify-end px-2', props.rail === true && 'relative', NO_TOUCH_SELECT)}
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
          <span key={i} className="font-mono">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </span>
  );
}

/** A 36px avatar: the photo, else initials on panel-3. */
export function SheetAvatar(props: {
  name: string;
  src: string | null;
  dimmed?: boolean;
}): ReactElement {
  const initials = props.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-panel-3 text-sm font-medium text-fg-2',
        props.dimmed === true && 'opacity-50',
      )}
    >
      {props.src !== null && props.src !== '' ? (
        <img src={props.src} alt="" className="h-full w-full object-cover" />
      ) : (
        initials
      )}
    </span>
  );
}

/** "Sent Today at 2:05 pm" for the Message info sheet. Pure. */
export function sentLine(createdAt: string, timeZone: string, nowMs: number): string {
  const ms = Date.parse(createdAt);
  if (Number.isNaN(ms)) return '';
  const day = dayPillLabel(civilDay(ms, timeZone), nowMs, timeZone);
  return `Sent ${day} at ${formatClockTime(ms, timeZone)}`;
}

/** The group Message info sheet: who has read the message and who has not. */
export function MessageInfoSheet(props: {
  open: boolean;
  onClose: () => void;
  createdAt: string;
  timeZone: string;
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
        <h3 className="py-2 text-sm font-semibold uppercase tracking-[0.06em] text-fg-2">
          Read by <span className="font-mono">{props.read.length}</span>
        </h3>
        <ul>
          {props.read.map((pos) => (
            <li key={pos.userId} className="flex min-h-[52px] items-center gap-3 py-1">
              <SheetAvatar
                name={nameOf(pos.userId)}
                src={byId.get(pos.userId)?.avatarUrl ?? null}
              />
              <span className="min-w-0 flex-1 truncate text-base text-fg">
                {nameOf(pos.userId)}
              </span>
              {pos.readAt !== null ? (
                <span className="font-mono text-sm tabular-nums text-fg-3">
                  {formatClockTime(pos.readAt, props.timeZone)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="my-2 h-px bg-border" aria-hidden="true" />
        <h3 className="py-2 text-sm font-semibold uppercase tracking-[0.06em] text-fg-2">
          Not read yet <span className="font-mono">{props.unread.length}</span>
        </h3>
        <ul>
          {props.unread.map((id) => (
            <li key={id} className="flex min-h-[52px] items-center gap-3 py-1">
              <SheetAvatar name={nameOf(id)} src={byId.get(id)?.avatarUrl ?? null} dimmed />
              <span className="min-w-0 flex-1 truncate text-base text-fg-3">{nameOf(id)}</span>
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
            <Button variant="primary" className="min-w-[44px]" onClick={retry}>
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
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  data-reactor-tab={t.key}
                  onClick={() => setTab(t.key)}
                  className={cn(
                    'flex items-center gap-1.5 border px-4 text-base font-normal',
                    tab === t.key
                      ? 'border-accent-line bg-accent-soft text-accent'
                      : 'border-border text-fg-2',
                  )}
                >
                  <span>{t.emoji ?? 'All'}</span>
                  <span className="font-mono tabular-nums">{t.count}</span>
                </PressableRow>
              ))}
            </div>
            <ul>
              {rows.map((row, i) => {
                const body = (
                  <>
                    <SheetAvatar name={row.name} src={row.avatarUrl} />
                    <span className="flex min-w-0 flex-1 flex-col text-left">
                      <span className="truncate text-base text-fg">{row.name}</span>
                      {row.mine ? <span className="text-sm text-fg-3">Tap to remove</span> : null}
                    </span>
                    <span aria-hidden="true" className="text-2xl leading-none">
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
                        className="flex h-[52px] items-center gap-3 py-1"
                      >
                        {body}
                      </PressableRow>
                    ) : (
                      <div className="flex min-h-[52px] items-center gap-3 py-1">{body}</div>
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

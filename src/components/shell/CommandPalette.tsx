import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
  ReactNode,
  RefObject,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { IconSearch, IconX } from '@/components/ui/icons';
import { highlightNodes } from '@/components/ui/SearchHighlight';
import { startDmChannel } from '@/components/chat/chat-actions';
import { cn } from '@/lib/cn';
import { useModalFocus } from '@/lib/modal-focus';
import { DUR_BASE_MS } from '@/lib/motion';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { generateTraceId } from '@/lib/trace';
import { readMentionProfiles, READ_TIMEOUT_MS } from '@/lib/chat-reads';
import { formatRelativeTime } from '@/lib/chat/format-relative-time';
import {
  mentionIds,
  mentionNamesIn,
  rememberMentionRead,
  resolveSearchMentionText,
  searchActorName,
  unresolvedMentionIds,
} from '@/lib/chat/mentions';
import { notesChannelId } from '@/lib/chat/notes';
import {
  normalizeQuery,
  queryWords,
  searchMessages,
  searchQueryReady,
  snippetText,
  SEARCH_FAILED_COPY,
  type SearchHit,
} from '@/lib/chat/search';
import { safeTimeZone } from '@/lib/chat/time-format';
import { chatMessageHref } from '@/lib/inbox/bell-types';
import {
  deviceStorage,
  loadRecentEntries,
  readRecents,
  RECENT_TYPE_LABEL,
  type RecentEntry,
} from '@/lib/recent-items';
import {
  chatHitPath,
  CHAT_SEARCH_LIMIT,
  createPaletteSearchRunner,
  IDLE_PALETTE_SEARCH,
  PER_KIND_PREVIEW,
  searchWorkspace,
  workspaceHitTarget,
  PER_KIND_FULL,
  type HitTarget,
  type PaletteSearchRunner,
  type PaletteSearchState,
  type WorkspaceHit,
  type WorkspaceKind,
} from '@/lib/search/workspace-search';

/** Why the palette closed: a picked result moves on; anything else returns focus. */
export type PaletteCloseReason = 'dismiss' | 'pick';

interface CommandPaletteProps {
  open: boolean;
  onClose: (reason: PaletteCloseReason) => void;
  /**
   * The search field. The opener focuses it synchronously inside its own tap
   * (iOS raises the keyboard only then), so it must exist on the open render.
   */
  inputRef?: RefObject<HTMLInputElement>;
  /** The active workspace: search runs only inside it. */
  workspaceId: string | null;
  /** The active workspace's short key, for post and brief links. */
  workspaceKey: string | null;
  /** The signed-in user: recents are theirs, and their own row opens Notes. */
  userId: string | null;
}

export type ResultGroup =
  | 'People'
  | 'Posts'
  | 'Briefs'
  | 'Comments'
  | 'Files'
  | 'Plans'
  | 'Plan items'
  | 'Tasks'
  | 'Groups'
  | 'Chat';

/** Result groups, in the order they show. */
export const RESULT_GROUPS: readonly ResultGroup[] = [
  'People',
  'Posts',
  'Briefs',
  'Comments',
  'Files',
  'Plans',
  'Plan items',
  'Tasks',
  'Groups',
  'Chat',
];

/** The workspace group each kind lands in. */
export const KIND_GROUP: Record<WorkspaceKind, ResultGroup> = {
  person: 'People',
  post: 'Posts',
  brief: 'Briefs',
  comment: 'Comments',
  file: 'Files',
  plan: 'Plans',
  plan_item: 'Plan items',
  task: 'Tasks',
  chat_group: 'Groups',
};

const GROUP_KIND = new Map<ResultGroup, WorkspaceKind>(
  (Object.entries(KIND_GROUP) as Array<[WorkspaceKind, ResultGroup]>).map(([k, g]) => [g, k]),
);

/** Rows a group shows before "Show all". */
export const GROUP_PREVIEW = PER_KIND_PREVIEW;

/** The empty-search section. */
export const RECENT_LABEL = 'Recent';

/** One keyboard-reachable row: a recent, a result, or a group's "Show all". */
export type PaletteItem =
  | {
      id: string;
      type: 'result';
      group: ResultGroup;
      title: string;
      snippet: string;
      time: string;
      target: HitTarget;
    }
  | { id: string; type: 'recent'; title: string; typeLabel: string; target: HitTarget }
  | { id: string; type: 'more'; group: ResultGroup; count: number };

export interface PaletteSection {
  label: typeof RECENT_LABEL | ResultGroup;
  items: PaletteItem[];
}

/** The search line of a body: mentions resolved (never a raw token), cut near the match. */
function lineOf(body: string, words: readonly string[], workspaceId: string | null): string {
  return snippetText(
    resolveSearchMentionText(body, workspaceId),
    words,
    mentionNamesIn(workspaceId),
  );
}

/** A workspace hit as a row. Pure over the name registry. */
function workspaceRow(
  hit: WorkspaceHit,
  ctx: {
    query: string;
    words: readonly string[];
    workspaceId: string | null;
    workspaceKey: string | null;
  },
  time: string,
): PaletteItem {
  let snippet = '';
  if (hit.kind === 'person') {
    snippet = hit.snippet !== '' ? `@${hit.snippet}` : '';
  } else if (hit.kind === 'file') {
    snippet = hit.snippet;
  } else if (hit.snippet !== '') {
    snippet = lineOf(hit.snippet, ctx.words, ctx.workspaceId);
  }
  if (hit.kind === 'comment' && hit.actorUserId !== null) {
    const actor = searchActorName(ctx.workspaceId, hit.actorUserId, hit.actorIsMember);
    if (actor !== undefined) snippet = `${actor}: ${snippet}`;
  }
  return {
    id: `${hit.kind}-${hit.id}`,
    type: 'result',
    group: KIND_GROUP[hit.kind],
    title: hit.title,
    snippet,
    time: hit.kind === 'person' ? '' : time,
    target: workspaceHitTarget(hit, ctx.workspaceKey, ctx.query),
  };
}

/**
 * A chat hit's title: its sender, "Former member" only once a read confirmed
 * they left, and nothing while their name is not known yet. Pure over the registry.
 */
export function chatSenderTitle(hit: SearchHit, workspaceId: string | null): string {
  if (hit.senderUserId === null) return 'Chat';
  return searchActorName(workspaceId, hit.senderUserId) ?? '';
}

/**
 * The palette's sections. Empty search: Recent. From 2 characters, once
 * results are in: People, Posts, Briefs, Comments, Files, Plans, Plan items,
 * Tasks, Groups, Chat; empty groups hidden; each capped at 5 with "Show all
 * (N)" (N the server's total) unless expanded. Pure.
 */
export function paletteSections(input: {
  query: string;
  search: PaletteSearchState;
  recents: readonly RecentEntry[];
  expanded: ReadonlySet<ResultGroup>;
  workspaceId: string | null;
  workspaceKey: string | null;
  nowMs: number;
  timeZone: string;
}): PaletteSection[] {
  const query = normalizeQuery(input.query);
  if (query === '') {
    if (input.recents.length === 0) return [];
    return [
      {
        label: RECENT_LABEL,
        items: input.recents.map((r) => ({
          id: `recent-${r.type}-${r.id}`,
          type: 'recent',
          title: r.title,
          typeLabel: RECENT_TYPE_LABEL[r.type],
          target: r.target,
        })),
      },
    ];
  }
  const { search } = input;
  if (search.status !== 'ready' || search.query !== query) return [];
  const words = queryWords(search.query);
  const time = (createdAt: string): string => {
    const ts = Date.parse(createdAt);
    return Number.isNaN(ts) ? '' : formatRelativeTime(ts, input.nowMs, input.timeZone);
  };
  const ctx = {
    query: search.query,
    words,
    workspaceId: input.workspaceId,
    workspaceKey: input.workspaceKey,
  };
  const byGroup = new Map<ResultGroup, PaletteItem[]>(RESULT_GROUPS.map((g) => [g, []]));
  for (const hit of search.workspace) {
    byGroup.get(KIND_GROUP[hit.kind])?.push(workspaceRow(hit, ctx, time(hit.createdAt)));
  }
  for (const hit of search.chat) {
    byGroup.get('Chat')?.push({
      id: `chat-${hit.id}`,
      type: 'result',
      group: 'Chat',
      title: chatSenderTitle(hit, input.workspaceId),
      snippet:
        hit.body.trim() === '' && hit.mediaLine !== undefined && hit.mediaLine !== ''
          ? hit.mediaLine
          : lineOf(hit.body, words, input.workspaceId),
      time: time(hit.createdAt),
      target: { path: chatHitPath(hit, search.query) },
    });
  }
  const sections: PaletteSection[] = [];
  for (const group of RESULT_GROUPS) {
    const all = (byGroup.get(group) ?? []).slice(0, Math.max(PER_KIND_FULL, CHAT_SEARCH_LIMIT));
    if (all.length === 0) continue;
    const kind = GROUP_KIND.get(group);
    const total = kind !== undefined ? Math.max(search.counts[kind] ?? 0, all.length) : all.length;
    const open = input.expanded.has(group);
    const items = open ? all : all.slice(0, GROUP_PREVIEW);
    if (!open && total > items.length) {
      items.push({ id: `more-${group}`, type: 'more', group, count: total });
    }
    sections.push({ label: group, items });
  }
  return sections;
}

/** The empty copy for a query with no hits. Pure. */
export function emptyCopy(query: string): string {
  return `Nothing called "${normalizeQuery(query)}"`;
}

/** The person, mention and actor ids a set of rows needs names for. Pure. */
export function namesNeeded(
  workspace: readonly WorkspaceHit[],
  chat: readonly SearchHit[],
): string[] {
  const ids: string[] = [];
  for (const hit of workspace) {
    ids.push(...mentionIds(hit.snippet));
    if (hit.kind === 'comment' && hit.actorUserId !== null && hit.actorIsMember) {
      ids.push(hit.actorUserId);
    }
  }
  for (const hit of chat) {
    ids.push(...mentionIds(hit.body));
    if (hit.senderUserId !== null) ids.push(hit.senderUserId);
  }
  return ids;
}

const ROW =
  'flex w-full items-center min-h-[44px] px-2 rounded-md text-sm text-left transition-colors active:bg-accent-soft';

/** The keyboard-selected (or hovered) row: the accent tint, the pressed row's tint too. */
const ACTIVE_ROW = 'bg-accent-soft text-fg';

export interface PaletteBodyProps {
  query: string;
  search: PaletteSearchState;
  sections: PaletteSection[];
  active: number;
  onHover: (index: number) => void;
  onPick: (item: PaletteItem) => void;
  onRetry: () => void;
}

/** The palette's list: sections, then the loading, empty or error line. Pure. */
export function PaletteBody(props: PaletteBodyProps): ReactElement {
  const { search, sections } = props;
  const words = queryWords(search.query);
  const flat = sections.flatMap((s) => s.items);
  const ready = searchQueryReady(props.query) && search.query === normalizeQuery(props.query);
  const hits = search.workspace.length + search.chat.length;
  let status: ReactNode = null;
  if (ready && search.status === 'loading') {
    status = (
      <div data-palette-state="loading" className="px-4 py-3 text-sm text-fg-3">
        Searching…
      </div>
    );
  } else if (ready && search.status === 'error') {
    status = (
      <div
        data-palette-state="error"
        className="flex items-center justify-between gap-3 px-4 text-sm text-fg-2"
      >
        <span className="truncate">{SEARCH_FAILED_COPY}</span>
        <button
          type="button"
          data-palette-retry=""
          onClick={props.onRetry}
          className="min-h-[44px] px-2 font-medium text-accent"
        >
          Retry
        </button>
      </div>
    );
  } else if (ready && search.status === 'ready' && hits === 0) {
    status = (
      <div data-palette-state="empty" className="px-4 py-6 text-center text-sm text-fg-3">
        {emptyCopy(props.query)}
      </div>
    );
  }
  return (
    <>
      {sections.map((section) => (
        <div
          key={section.label}
          role="group"
          aria-label={section.label}
          data-palette-group={section.label}
          className="px-2 pb-1"
        >
          <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-fg-3">
            {section.label}
          </div>
          {section.items.map((item) => {
            const index = flat.indexOf(item);
            const isActive = index === props.active;
            const tone = isActive ? ACTIVE_ROW : 'text-fg-2';
            const common = {
              type: 'button' as const,
              role: 'option',
              'aria-selected': isActive,
              'data-palette-item': item.id,
              'data-active': isActive ? '' : undefined,
              onMouseEnter: () => props.onHover(index),
              onClick: () => props.onPick(item),
            };
            if (item.type === 'more') {
              return (
                <button
                  key={item.id}
                  {...common}
                  className={cn(ROW, 'font-medium', isActive ? ACTIVE_ROW : 'text-accent')}
                >
                  {`Show all (${item.count})`}
                </button>
              );
            }
            if (item.type === 'recent') {
              return (
                <button
                  key={item.id}
                  {...common}
                  className={cn(ROW, 'flex-col items-stretch justify-center gap-0.5 py-1.5', tone)}
                >
                  <span className="min-w-0 truncate font-medium text-fg">{item.title}</span>
                  <span className="truncate text-xs text-fg-3">{item.typeLabel}</span>
                </button>
              );
            }
            return (
              <button
                key={item.id}
                {...common}
                className={cn(ROW, 'flex-col items-stretch justify-center gap-0.5 py-1.5', tone)}
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium text-fg">
                    {highlightNodes(item.title, words)}
                  </span>
                  {item.time !== '' ? (
                    <span className="shrink-0 text-xs text-fg-3">{item.time}</span>
                  ) : null}
                </span>
                {item.snippet !== '' ? (
                  <span className="truncate text-xs text-fg-3">
                    {highlightNodes(item.snippet, words)}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
      {status}
    </>
  );
}

/** One batched name read (users + workspace_members, one .in() each) for ids not known yet. */
export async function resolvePaletteNames(
  workspaceId: string,
  ids: readonly string[],
  read: (userIds: string[]) => ReturnType<typeof readMentionProfiles> = (userIds) =>
    readMentionProfiles(supabase, { workspaceId, userIds, timeoutMs: READ_TIMEOUT_MS }),
): Promise<void> {
  const need = unresolvedMentionIds(workspaceId, ids);
  if (need.length === 0) return;
  const res = await read(need);
  if (!res.ok) {
    logger.warn('palette: name read failed', { error: res.error.message });
    return;
  }
  rememberMentionRead(workspaceId, need, res.data);
}

// Exit transition length; mirrors --dur-base so the palette stays mounted for
// the fade/scale-out, then unmounts. Fires even under prefers-reduced-motion
// (CSS collapses to 1ms), so the closing phase always completes.
const EXIT_MS = DUR_BASE_MS;

export function CommandPalette({
  open,
  onClose,
  inputRef: givenInputRef,
  workspaceId,
  workspaceKey,
  userId,
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const ownInputRef = useRef<HTMLInputElement>(null);
  const inputRef = givenInputRef ?? ownInputRef;
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<ResultGroup>>(new Set());
  const [search, setSearch] = useState<PaletteSearchState>(IDLE_PALETTE_SEARCH);
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const runnerRef = useRef<PaletteSearchRunner | null>(null);
  // `rendered` keeps the palette mounted through its exit; `entered` drives the
  // enter/exit transition.
  const [rendered, setRendered] = useState(open);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    if (open) {
      setRendered(true);
      const raf = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(raf);
    }
    setEntered(false);
    const timer = setTimeout(() => setRendered(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [open]);

  // One runner per open palette and workspace: every search stays inside the
  // active workspace, and closing or switching aborts whatever is in flight.
  useEffect(() => {
    if (!open || workspaceId === null) return;
    const runner = createPaletteSearchRunner({
      searchWorkspace: (q, signal, full) =>
        searchWorkspace({
          client: supabase,
          workspaceId,
          query: q,
          signal,
          perKind: full ? PER_KIND_FULL : PER_KIND_PREVIEW,
          counts: !full,
        }),
      searchChat: (q, signal) =>
        searchMessages({
          client: supabase,
          workspaceId,
          query: q,
          signal,
          limit: CHAT_SEARCH_LIMIT,
        }),
      prepare: (ws, chat) => resolvePaletteNames(workspaceId, namesNeeded(ws, chat)),
      onChange: setSearch,
    });
    runnerRef.current = runner;
    setSearch(IDLE_PALETTE_SEARCH);
    return () => {
      runner.dispose();
      if (runnerRef.current === runner) runnerRef.current = null;
    };
  }, [open, workspaceId]);

  // Recents: this device's list for me in this workspace, titled with one
  // batched read per type; anything not returned drops.
  useEffect(() => {
    setRecents([]);
    if (!open || workspaceId === null || userId === null) return;
    const items = readRecents(deviceStorage(), userId, workspaceId);
    if (items.length === 0) return;
    const controller = new AbortController();
    void loadRecentEntries({
      client: supabase,
      workspaceId,
      workspaceKey,
      userId,
      items,
      signal: controller.signal,
    }).then((entries) => {
      if (!controller.signal.aborted) setRecents(entries);
    });
    return () => controller.abort();
  }, [open, workspaceId, workspaceKey, userId]);

  useEffect(() => {
    runnerRef.current?.setQuery(query);
  }, [query, workspaceId, open]);

  const sections = useMemo(
    () =>
      paletteSections({
        query,
        search,
        recents,
        expanded,
        workspaceId,
        workspaceKey,
        nowMs: Date.now(),
        timeZone: safeTimeZone(''),
      }),
    [query, search, recents, expanded, workspaceKey, workspaceId],
  );
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  // A fresh search on every open. The opener already focused the field inside
  // its tap; this focus only covers an opener that could not (a no-op otherwise).
  useEffect(() => {
    // Both ways: a reopen during the close fade never shows the old text.
    setQuery('');
    setActive(0);
    if (open && document.activeElement !== inputRef.current) inputRef.current?.focus();
  }, [open, inputRef]);

  // Tab stays inside the palette while open; the field already holds focus by
  // the time this runs (the opener's tap or the effect above), so the shared
  // modal focus leaves it there and only traps.
  useModalFocus(panelRef, open);

  useEffect(() => {
    setActive(0);
    setExpanded(new Set());
  }, [query]);

  // Keep the keyboard's row in view.
  useEffect(() => {
    listRef.current?.querySelector('[data-active]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active, flat]);

  // Open renders at once (not after an effect), so the opener's synchronous
  // focus() finds the field in the same tap.
  if (!open && !rendered) {
    return null;
  }

  function openTarget(target: HitTarget): void {
    onClose('pick');
    if ('path' in target) {
      navigate(target.path);
      return;
    }
    if (workspaceId === null) return;
    if (target.person === userId) {
      navigate(chatMessageHref(notesChannelId(workspaceId, target.person), null));
      return;
    }
    void startDmChannel(
      supabase,
      { workspaceId, peerUserId: target.person, traceId: generateTraceId() },
      (channelId) => navigate(chatMessageHref(channelId, null)),
    ).then((error) => {
      if (error !== null) logger.warn('palette: open DM failed', { error: error.message });
    });
  }

  function pick(item: PaletteItem | undefined): void {
    if (item === undefined) {
      return;
    }
    if (item.type === 'more') {
      setExpanded((prev) => new Set(prev).add(item.group));
      const kind = GROUP_KIND.get(item.group);
      if (kind !== undefined) runnerRef.current?.expand(kind);
      return;
    }
    openTarget(item.target);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose('dismiss');
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((value) => Math.min(value + 1, flat.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((value) => Math.max(value - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      pick(flat[active]);
    }
  }

  function onOverlayClick(event: ReactMouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) {
      onClose('dismiss');
    }
  }

  return (
    <div
      data-palette-overlay=""
      className={cn(
        'fixed inset-0 z-50 bg-scrim flex items-stretch justify-center sm:items-start sm:pt-[12vh] sm:px-4 transition-opacity duration-fast',
        entered ? 'opacity-100 ease-enter' : 'opacity-0 ease-exit',
      )}
      onClick={onOverlayClick}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className={cn(
          // Phones: a full-screen sheet. Wider: the centred card.
          // Axis: translateY (-8px) + scale from top center, crossfaded. No X,
          // no rotate.
          'flex flex-col w-full h-full bg-panel overflow-hidden origin-top transition-[opacity,transform] duration-base will-change-transform sm:h-auto sm:max-w-[560px] sm:rounded-xl sm:border sm:border-border-strong sm:shadow-2xl',
          entered
            ? 'translate-y-0 scale-100 opacity-100 ease-enter'
            : '-translate-y-2 scale-[0.985] opacity-0 ease-exit',
        )}
      >
        <div className="flex shrink-0 items-center gap-2.5 px-4 border-b border-border pt-[env(safe-area-inset-top)] sm:pt-0">
          <IconSearch size={18} className="text-fg-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search anything"
            aria-label="Search this workspace"
            enterKeyHint="search"
            className="flex-1 min-w-0 h-12 bg-transparent outline-none text-base sm:text-sm placeholder:text-fg-3"
          />
          {query !== '' ? (
            <button
              type="button"
              aria-label="Clear search"
              data-palette-clear=""
              // The field keeps focus (and the phone keeps its keyboard).
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setQuery('');
                inputRef.current?.focus({ preventScroll: true });
              }}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-fg-3 hover:bg-panel-2 hover:text-fg"
            >
              <IconX size={16} />
            </button>
          ) : null}
          <kbd className="hidden sm:inline text-[11px] text-fg-3 border border-border rounded px-1.5 py-0.5">
            Esc
          </kbd>
          <button
            type="button"
            onClick={() => onClose('dismiss')}
            className="sm:hidden min-h-[44px] min-w-[44px] text-sm font-medium text-accent"
          >
            Cancel
          </button>
        </div>
        <div
          ref={listRef}
          role="listbox"
          aria-label="Search this workspace"
          className="flex-1 overflow-y-auto py-2 sm:flex-none sm:max-h-[60vh]"
        >
          <PaletteBody
            query={query}
            search={search}
            sections={sections}
            active={active}
            onHover={setActive}
            onPick={pick}
            onRetry={() => runnerRef.current?.retry()}
          />
        </div>
      </div>
    </div>
  );
}

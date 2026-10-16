import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactElement,
  ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { IconSearch } from '@/components/ui/icons';
import { boldMatches } from '@/components/chat/SearchResults';
import { cn } from '@/lib/cn';
import { DUR_BASE_MS } from '@/lib/motion';
import { supabase } from '@/lib/supabase';
import type { PreviewNameOf } from '@/lib/chat/chat-store';
import { formatRelativeTime } from '@/lib/chat/format-relative-time';
import { mentionNamesIn } from '@/lib/chat/mentions';
import {
  normalizeQuery,
  queryWords,
  searchMessages,
  searchQueryReady,
  snippetText,
  SEARCH_FAILED_COPY,
} from '@/lib/chat/search';
import { safeTimeZone } from '@/lib/chat/time-format';
import {
  chatHitPath,
  createPaletteSearchRunner,
  IDLE_PALETTE_SEARCH,
  searchWorkspace,
  workspaceHitPath,
  WORKSPACE_SEARCH_LIMIT,
  type PaletteSearchRunner,
  type PaletteSearchState,
} from '@/lib/search/workspace-search';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** The active workspace: search runs only inside it. */
  workspaceId: string | null;
  /** The active workspace's short key, for post and brief links. */
  workspaceKey: string | null;
}

export type ResultGroup = 'Posts' | 'Briefs' | 'Comments' | 'Chat';

/** Result groups, in the order they show. */
export const RESULT_GROUPS: readonly ResultGroup[] = ['Posts', 'Briefs', 'Comments', 'Chat'];

/** Rows a group shows before "Show all". */
export const GROUP_PREVIEW = 5;

/** One keyboard-reachable row: a Go to command, a result, or a group's "Show all". */
export type PaletteItem =
  | { id: string; type: 'goto'; label: string; path: string }
  | {
      id: string;
      type: 'result';
      group: ResultGroup;
      title: string;
      snippet: string;
      time: string;
      path: string;
    }
  | { id: string; type: 'more'; group: ResultGroup; count: number };

export interface PaletteSection {
  label: 'Go to' | ResultGroup;
  items: PaletteItem[];
}

const GOTO: ReadonlyArray<{ id: string; label: string; path: string }> = [
  { id: 'goto-pipeline', label: 'Pipeline', path: '/pipeline' },
  { id: 'goto-briefs', label: 'Briefs', path: '/briefs' },
  { id: 'goto-activity', label: 'Activity', path: '/activity' },
  { id: 'goto-help', label: 'Help', path: '/help' },
];

/**
 * The palette's sections: the Go to commands filtered by label, then (from 2
 * characters, once results are in) Posts, Briefs, Comments, Chat, each capped
 * at 5 rows with a "Show all" row unless expanded. Pure.
 */
export function paletteSections(input: {
  query: string;
  search: PaletteSearchState;
  expanded: ReadonlySet<ResultGroup>;
  workspaceKey: string | null;
  nameOf: PreviewNameOf;
  nowMs: number;
  timeZone: string;
}): PaletteSection[] {
  const needle = normalizeQuery(input.query).toLowerCase();
  const sections: PaletteSection[] = [];
  const gotos = needle ? GOTO.filter((g) => g.label.toLowerCase().includes(needle)) : GOTO;
  if (gotos.length > 0) {
    sections.push({
      label: 'Go to',
      items: gotos.map((g) => ({ id: g.id, type: 'goto', label: g.label, path: g.path })),
    });
  }
  const { search } = input;
  if (search.status !== 'ready' || search.query !== normalizeQuery(input.query)) return sections;
  const words = queryWords(search.query);
  const time = (createdAt: string): string => {
    const ts = Date.parse(createdAt);
    return Number.isNaN(ts) ? '' : formatRelativeTime(ts, input.nowMs, input.timeZone);
  };
  const byGroup: Record<ResultGroup, PaletteItem[]> = {
    Posts: [],
    Briefs: [],
    Comments: [],
    Chat: [],
  };
  for (const hit of search.workspace) {
    const group: ResultGroup =
      hit.kind === 'post' ? 'Posts' : hit.kind === 'brief' ? 'Briefs' : 'Comments';
    byGroup[group].push({
      id: `${hit.kind}-${hit.id}`,
      type: 'result',
      group,
      title: hit.title,
      snippet: hit.snippet,
      time: time(hit.createdAt),
      path: workspaceHitPath(hit, input.workspaceKey),
    });
  }
  for (const hit of search.chat) {
    byGroup.Chat.push({
      id: `chat-${hit.id}`,
      type: 'result',
      group: 'Chat',
      title: input.nameOf(hit.senderUserId ?? '') ?? 'Chat',
      snippet:
        hit.body.trim() === '' && hit.mediaLine !== undefined && hit.mediaLine !== ''
          ? hit.mediaLine
          : snippetText(hit.body, words, input.nameOf),
      time: time(hit.createdAt),
      path: chatHitPath(hit),
    });
  }
  for (const group of RESULT_GROUPS) {
    const all = byGroup[group].slice(0, WORKSPACE_SEARCH_LIMIT);
    if (all.length === 0) continue;
    const open = input.expanded.has(group) || all.length <= GROUP_PREVIEW;
    const items = open ? all : all.slice(0, GROUP_PREVIEW);
    if (!open) items.push({ id: `more-${group}`, type: 'more', group, count: all.length });
    sections.push({ label: group, items });
  }
  return sections;
}

/** The empty copy for a query with no hits. Pure. */
export function emptyCopy(query: string): string {
  return `No results for "${normalizeQuery(query)}"`;
}

const ROW =
  'flex w-full items-center min-h-[44px] px-2 rounded-md text-sm text-left transition-colors';

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
  } else if (flat.length === 0) {
    status = (
      <div data-palette-state="empty" className="px-4 py-6 text-center text-sm text-fg-3">
        No results
      </div>
    );
  }
  return (
    <>
      {sections.map((section) => (
        <div key={section.label} data-palette-group={section.label} className="px-2 pb-1">
          <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-fg-3">
            {section.label}
          </div>
          {section.items.map((item) => {
            const index = flat.indexOf(item);
            const isActive = index === props.active;
            const tone = isActive ? 'bg-panel-2 text-fg' : 'text-fg-2';
            if (item.type === 'goto') {
              return (
                <button
                  key={item.id}
                  type="button"
                  data-palette-item={item.id}
                  onMouseEnter={() => props.onHover(index)}
                  onClick={() => props.onPick(item)}
                  className={cn(ROW, tone)}
                >
                  {item.label}
                </button>
              );
            }
            if (item.type === 'more') {
              return (
                <button
                  key={item.id}
                  type="button"
                  data-palette-item={item.id}
                  onMouseEnter={() => props.onHover(index)}
                  onClick={() => props.onPick(item)}
                  className={cn(
                    ROW,
                    'font-medium',
                    isActive ? 'bg-panel-2 text-fg' : 'text-accent',
                  )}
                >
                  {`Show all (${item.count})`}
                </button>
              );
            }
            return (
              <button
                key={item.id}
                type="button"
                data-palette-item={item.id}
                onMouseEnter={() => props.onHover(index)}
                onClick={() => props.onPick(item)}
                className={cn(ROW, 'flex-col items-stretch justify-center gap-0.5 py-1.5', tone)}
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium text-fg">
                    {boldMatches(item.title, words)}
                  </span>
                  <span className="shrink-0 text-xs text-fg-3">{item.time}</span>
                </span>
                {item.snippet !== '' ? (
                  <span className="truncate text-xs text-fg-3">
                    {boldMatches(item.snippet, words)}
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

// Exit transition length; mirrors --dur-base so the palette stays mounted for
// the fade/scale-out, then unmounts. Fires even under prefers-reduced-motion
// (CSS collapses to 1ms), so the closing phase always completes.
const EXIT_MS = DUR_BASE_MS;

export function CommandPalette({ open, onClose, workspaceId, workspaceKey }: CommandPaletteProps) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<ResultGroup>>(new Set());
  const [search, setSearch] = useState<PaletteSearchState>(IDLE_PALETTE_SEARCH);
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

  // One runner per open palette and workspace: both searches stay inside the
  // active workspace, and closing or switching aborts whatever is in flight.
  useEffect(() => {
    if (!open || workspaceId === null) return;
    const runner = createPaletteSearchRunner({
      searchWorkspace: (q, signal) =>
        searchWorkspace({ client: supabase, workspaceId, query: q, signal }),
      searchChat: (q, signal) =>
        searchMessages({
          client: supabase,
          workspaceId,
          query: q,
          signal,
          limit: WORKSPACE_SEARCH_LIMIT,
        }),
      onChange: setSearch,
    });
    runnerRef.current = runner;
    setSearch(IDLE_PALETTE_SEARCH);
    return () => {
      runner.dispose();
      if (runnerRef.current === runner) runnerRef.current = null;
    };
  }, [open, workspaceId]);

  useEffect(() => {
    runnerRef.current?.setQuery(query);
  }, [query, workspaceId, open]);

  const sections = useMemo(
    () =>
      paletteSections({
        query,
        search,
        expanded,
        workspaceKey,
        nameOf: mentionNamesIn(workspaceId),
        nowMs: Date.now(),
        timeZone: safeTimeZone(''),
      }),
    [query, search, expanded, workspaceKey, workspaceId],
  );
  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
    setExpanded(new Set());
  }, [query]);

  if (!rendered) {
    return null;
  }

  function pick(item: PaletteItem | undefined): void {
    if (item === undefined) {
      return;
    }
    if (item.type === 'more') {
      setExpanded((prev) => new Set(prev).add(item.group));
      return;
    }
    onClose();
    navigate(item.path);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
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
      onClose();
    }
  }

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 bg-black/45 flex items-stretch justify-center sm:items-start sm:pt-[12vh] sm:px-4 transition-opacity duration-fast',
        entered ? 'opacity-100 ease-enter' : 'opacity-0 ease-exit',
      )}
      onClick={onOverlayClick}
    >
      <div
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
            placeholder="Search or jump to"
            aria-label="Search this workspace"
            className="flex-1 min-w-0 h-12 bg-transparent outline-none text-base sm:text-sm placeholder:text-fg-3"
          />
          <kbd className="hidden sm:inline text-[11px] text-fg-3 border border-border rounded px-1.5 py-0.5">
            Esc
          </kbd>
          <button
            type="button"
            onClick={onClose}
            className="sm:hidden min-h-[44px] min-w-[44px] text-sm font-medium text-accent"
          >
            Cancel
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-2 sm:flex-none sm:max-h-[60vh]">
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

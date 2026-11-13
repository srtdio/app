// Search inside one chat (13 Nov 2026, WhatsApp's way). The chat bar's search
// key opens ChatSearchField in the bar's place (cursor in, keyboard up, Cancel
// closes); ChatSearchSteps takes the composer's place: "4 of 28" and up (an
// older hit) / down (a newer hit). Hits are the chat's whole history through
// chat_message_search (p_channel_id, the shared search runner: debounce,
// abort, keyset pages). The current hit is jumped to with the chat's own jump
// (older pages load as needed) and ringed (data-search-current, index.css);
// every hit word is coloured through SearchWordsContext. Laptop: Enter = older,
// Shift+Enter = newer, Esc closes. No read on paint: the first read goes out
// only once a query of 2+ characters settles.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Text } from '@/components/ui/Text';
import { ICON_SIZE, IconChevronDown, IconSearch } from '@/components/ui/icons';
import { TRAILING_PULL } from '@/components/ui/layout';
import { cn } from '@/lib/cn';
import { supabase } from '@/lib/supabase';
import {
  IDLE_SEARCH,
  createSearchRunner,
  queryWords,
  searchMessages,
  type SearchRunner,
  type SearchState,
} from '@/lib/chat/search';
import {
  canStepNewer,
  canStepOlder,
  localHits,
  searchPlaceholder,
  stepLabel,
  type SearchableRow,
  type StepState,
} from '@/lib/chat/in-chat-search';

/** The search key's name. */
export const CHAT_SEARCH_LABEL = 'Search in this chat';

/** The chat bar's search key (trailing, 44, its glyph on the content edge). */
export function ChatSearchKey(props: {
  onOpen: () => void;
  /** Inside HeaderBar's actions slot (the slot applies the trailing rule). */
  inBar?: boolean;
  label?: string;
}): ReactElement {
  return (
    <IconButton
      label={props.label ?? CHAT_SEARCH_LABEL}
      data-chat-search-key=""
      onClick={props.onOpen}
      className={props.inBar === true ? 'shrink-0' : cn('ml-auto shrink-0', TRAILING_PULL)}
    >
      <IconSearch size={ICON_SIZE.control} />
    </IconButton>
  );
}

export interface ChatSearch {
  open: boolean;
  query: string;
  words: readonly string[];
  /** The message the walk stands on; null while none. */
  currentId: string | null;
  /** Every hit loaded so far (newest first): a comments list shows each reply hit. */
  hitIds: readonly string[];
  steps: StepState;
  loading: boolean;
  start: () => void;
  close: () => void;
  setQuery: (raw: string) => void;
  older: () => void;
  newer: () => void;
}

/**
 * The walk over one chat's hits. `onJump` moves the chat to a message (the
 * chat's jump: loads older pages, opens a reply's thread); `onWords` colours
 * the hit words (cleared on close).
 */
export function useChatSearch(input: {
  workspaceId: string | null;
  channelId: string | undefined;
  onJump: (messageId: string) => void;
  onWords: (words: readonly string[]) => void;
}): ChatSearch {
  const { workspaceId, channelId } = input;
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState('');
  const [state, setState] = useState<SearchState>(IDLE_SEARCH);
  const [index, setIndex] = useState(-1);
  const runnerRef = useRef<SearchRunner | null>(null);
  const latest = useRef(input);
  latest.current = input;

  // One runner per open search in one chat; disposed on close or chat switch.
  useEffect(() => {
    if (!open || workspaceId === null || channelId === undefined) return undefined;
    const runner = createSearchRunner({
      fetch: ({ query: q, before, signal }) =>
        searchMessages({ client: supabase, workspaceId, channelId, query: q, before, signal }),
      onChange: setState,
    });
    runnerRef.current = runner;
    return () => {
      runner.dispose();
      runnerRef.current = null;
    };
  }, [open, workspaceId, channelId]);

  // A chat switch closes the search (its hits belong to the other chat).
  useEffect(() => {
    setOpen(false);
    setQueryState('');
    setState(IDLE_SEARCH);
    setIndex(-1);
  }, [channelId]);

  // A fresh answer: the walk starts at the newest hit.
  const answerKey = state.status === 'ready' ? state.query : '';
  useEffect(() => {
    setIndex(state.status === 'ready' && state.hits.length > 0 ? 0 : -1);
    // Only a new answer resets the walk; a later page keeps the place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answerKey, state.status]);

  const words = useMemo(
    () => (open && state.status === 'ready' ? queryWords(state.query) : []),
    [open, state.status, state.query],
  );
  const currentId = index >= 0 ? (state.hits[index]?.id ?? null) : null;

  // Colour the words and move to the current hit.
  // Only while open: a palette jump's own words stay untouched otherwise.
  useEffect(() => {
    if (open) latest.current.onWords(words);
  }, [open, words]);
  useEffect(() => {
    if (currentId !== null) latest.current.onJump(currentId);
  }, [currentId]);

  const steps: StepState = {
    count: state.status === 'ready' ? state.hits.length : 0,
    index,
    hasMore: state.status === 'ready' && state.hasMore,
  };
  const ready = state.status === 'ready';

  const start = useCallback(() => setOpen(true), []);
  const close = useCallback(() => {
    setOpen(false);
    setQueryState('');
    setState(IDLE_SEARCH);
    setIndex(-1);
    latest.current.onWords([]);
  }, []);
  const setQuery = useCallback((raw: string) => {
    setQueryState(raw);
    runnerRef.current?.setQuery(raw);
  }, []);
  const older = useCallback(() => {
    if (!canStepOlder(steps)) return;
    if (index + 1 < state.hits.length) {
      setIndex(index + 1);
      return;
    }
    // The next page lands, then the walk steps onto its first hit.
    void runnerRef.current?.loadMore().then(() => {
      const after = runnerRef.current?.getState();
      if (after !== undefined && after.hits.length > index + 1) setIndex(index + 1);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, state.hits.length, steps.hasMore]);
  const newer = useCallback(() => {
    if (index > 0) setIndex(index - 1);
  }, [index]);

  return {
    open,
    query,
    words,
    currentId: ready ? currentId : null,
    hitIds: state.status === 'ready' ? state.hits.map((hit) => hit.id) : [],
    steps,
    loading: state.status === 'loading' || state.loadingMore,
    start,
    close,
    setQuery,
    older,
    newer,
  };
}

/**
 * The walk over a thread's own rows (13 Nov 2026): a thread holds all its
 * replies on screen, so its hits are read from the rows themselves
 * (`readRows`, screen order), no network read. Same walk and bar as a chat:
 * newest hit first, up = older, down = newer; `onJump` brings a row into view.
 */
export function useLocalSearch(input: {
  readRows: () => readonly SearchableRow[];
  onJump: (messageId: string) => void;
}): ChatSearch {
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState('');
  const [hits, setHits] = useState<readonly string[]>([]);
  const [index, setIndex] = useState(-1);
  const latest = useRef(input);
  latest.current = input;
  const asked = query.trim().length >= 2;
  const words = useMemo(() => (open && asked ? queryWords(query) : []), [open, asked, query]);
  const currentId = index >= 0 ? (hits[index] ?? null) : null;
  useEffect(() => {
    if (currentId !== null) latest.current.onJump(currentId);
  }, [currentId]);
  const close = useCallback(() => {
    setOpen(false);
    setQueryState('');
    setHits([]);
    setIndex(-1);
  }, []);
  const setQuery = useCallback((raw: string) => {
    setQueryState(raw);
    const next = localHits(latest.current.readRows(), raw);
    setHits(next);
    setIndex(next.length > 0 ? 0 : -1);
  }, []);
  const steps: StepState = { count: hits.length, index, hasMore: false };
  return {
    open,
    query,
    words,
    currentId,
    hitIds: hits,
    steps,
    loading: false,
    start: useCallback(() => setOpen(true), []),
    close,
    setQuery,
    older: () => {
      if (index + 1 < hits.length) setIndex(index + 1);
    },
    newer: () => {
      if (index > 0) setIndex(index - 1);
    },
  };
}

/**
 * The search box in the chat bar's place: the field (search tone, icon inside,
 * cursor in on open) and Cancel. Enter = older hit, Shift+Enter = newer, Esc closes.
 */
export function ChatSearchField(props: { chatName: string; search: ChatSearch }): ReactElement {
  const { search } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  // Synchronous focus on mount: the tap that opened it brings up the keyboard on iOS.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      search.close();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) search.newer();
      else search.older();
    }
  };
  return (
    <div data-chat-search="" className="group/sfield flex min-w-0 flex-1 items-center gap-3">
      <div className="relative min-w-0 flex-1">
        <span className="pointer-events-none absolute left-3 top-1/2 flex -translate-y-1/2 text-fg-3 group-focus-within/sfield:text-fg">
          <IconSearch size={ICON_SIZE.control} />
        </span>
        <Input
          ref={inputRef}
          tone="search"
          type="text"
          value={search.query}
          onChange={(event) => search.setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={searchPlaceholder(props.chatName)}
          aria-label={searchPlaceholder(props.chatName)}
          enterKeyHint="search"
          data-chat-search-field=""
          className="min-w-0 pl-12 pr-3"
        />
      </div>
      <Button
        type="button"
        variant="ghost"
        data-chat-search-cancel=""
        onClick={search.close}
        className="shrink-0"
      >
        Cancel
      </Button>
    </div>
  );
}

/** The step bar in the composer's place: "4 of 28", up = an older hit, down = a newer one. */
export function ChatSearchSteps(props: { search: ChatSearch }): ReactElement {
  const { search } = props;
  const label = search.query.trim().length < 2 ? '' : stepLabel(search.steps);
  // The keys never take focus from the field (the keyboard stays up on phone).
  const keep = (event: { preventDefault: () => void }): void => event.preventDefault();
  return (
    <div
      data-chat-search-steps=""
      className="flex h-14 shrink-0 items-center justify-between border-t bg-panel px-4 pb-[env(safe-area-inset-bottom)]"
    >
      <Text role="meta" aria-live="polite" data-chat-search-count="">
        {label}
      </Text>
      <span className={cn('flex', TRAILING_PULL)}>
        <IconButton
          label="Older match"
          data-chat-search-older=""
          disabled={!canStepOlder(search.steps)}
          onMouseDown={keep}
          onClick={search.older}
        >
          {/* Up: the one chevron, flipped (one icon per concept; nav size, as Plan's). */}
          <IconChevronDown size={ICON_SIZE.nav} className="-scale-y-100" />
        </IconButton>
        <IconButton
          label="Newer match"
          data-chat-search-newer=""
          disabled={!canStepNewer(search.steps)}
          onMouseDown={keep}
          onClick={search.newer}
        >
          <IconChevronDown size={ICON_SIZE.nav} />
        </IconButton>
      </span>
    </div>
  );
}

/**
 * Search the comments (13 Nov 2026): one set of parts for every comments list
 * (post, brief, Plan item, Bank idea). A "Comments" row with the search key;
 * the field takes the row; "N of M" takes the comment box's place (phone:
 * fixed in the bottom bar's place, which index.css hides while it shows;
 * laptop: sticky under the list). Every comment and reply is on the device,
 * so the hits come from memory (searchRowsOf + localHits), no read. Every
 * reply hit shows under its comment's replies row (SearchPeek, peekReplies),
 * the current one ringed; the thread stays shut until a reply is tapped.
 */
import type { ReactElement, ReactNode, RefObject } from 'react';
import { useContext } from 'react';
import {
  ChatSearchField,
  ChatSearchKey,
  ChatSearchSteps,
  useLocalSearch,
  type ChatSearch,
} from '@/components/chat/ChatSearch';
import { SEARCH_PEEK_INDENT, sized, type ChatLayout } from '@/components/chat/chat-type';
import { SearchCurrentContext, SearchWordsContext } from '@/components/ui/SearchHighlight';
import { SECTION_LABEL } from '@/components/ui/Text';
import { searchRowsOf, type SearchableMessage } from '@/lib/chat/in-chat-search';

/** The comments search's key and field words. */
export const COMMENTS_SEARCH_LABEL = 'Search in comments';
const COMMENTS_SEARCH_PLACE = 'comments';

/**
 * The walk over a comments list: `threads` reads every comment with its
 * replies (screen order) at query time; a hit's row comes to the middle of
 * its scroller inside `scope`.
 */
export function useCommentsSearch(input: {
  threads: () => readonly { root: SearchableMessage; replies: readonly SearchableMessage[] }[];
  scope: RefObject<HTMLElement | null>;
}): ChatSearch {
  return useLocalSearch({
    readRows: () => searchRowsOf(input.threads()),
    onJump: (id) => {
      const row = input.scope.current?.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
      if (row != null) centreRowY(row);
    },
  });
}

/** The "Comments" row: the label and the search key, or the field while searching. */
export function CommentsSearchHead(props: {
  search: ChatSearch;
  /** Whether there is anything to search (the key shows only then). */
  searchable: boolean;
}): ReactElement {
  const { search } = props;
  return (
    <div data-comments-head="" className="flex min-h-11 items-center">
      {search.open ? (
        <ChatSearchField chatName={COMMENTS_SEARCH_PLACE} search={search} />
      ) : (
        <>
          <h4 className={SECTION_LABEL}>Comments</h4>
          {props.searchable ? (
            <ChatSearchKey label={COMMENTS_SEARCH_LABEL} onOpen={search.start} />
          ) : null}
        </>
      )}
    </div>
  );
}

/** The list's hit words and current hit while searching; the screen's own otherwise. */
export function CommentsSearchScope(props: {
  search: ChatSearch;
  children: ReactNode;
}): ReactElement {
  const outerWords = useContext(SearchWordsContext);
  const outerCurrent = useContext(SearchCurrentContext);
  const { search } = props;
  return (
    <SearchWordsContext.Provider value={search.open ? search.words : outerWords}>
      <SearchCurrentContext.Provider value={search.open ? search.currentId : outerCurrent}>
        {props.children}
      </SearchCurrentContext.Provider>
    </SearchWordsContext.Provider>
  );
}

/** "N of M" in the comment box's place (phone: the bottom bar's place). */
export function CommentsSearchDock(props: { search: ChatSearch }): ReactElement {
  return (
    <div
      data-comments-search-dock=""
      className="fixed inset-x-0 bottom-0 z-dock md:sticky md:inset-x-auto"
    >
      <ChatSearchSteps search={props.search} />
    </div>
  );
}

/** A reply hit, alone under its comment's replies row: its photo on the comment's text column. */
export function SearchPeek(props: { layout: ChatLayout; children: ReactNode }): ReactElement {
  return (
    <li data-search-peek="" className={sized(SEARCH_PEEK_INDENT, props.layout)}>
      <ul>{props.children}</ul>
    </li>
  );
}

/**
 * The reply hits under one comment (13 Nov 2026): every reply of `rootId`
 * that the search matched, in screen order, each shown under the comment's
 * replies row (the current one ringed). None while not searching. Pure.
 */
export function peekReplies<T extends { id: string }>(
  search: ChatSearch,
  replies: ReadonlyMap<string, readonly T[]>,
  rootId: string,
): readonly T[] {
  if (!search.open || search.hitIds.length === 0) return [];
  const hits = new Set(search.hitIds);
  return (replies.get(rootId) ?? []).filter((reply) => hits.has(reply.id));
}

/**
 * Brings a hit's row to the middle of its scroller, vertically only (a row
 * bleeds past its column, so scrollIntoView would also slide the column sideways).
 */
function centreRowY(row: Element): void {
  let box: HTMLElement | null = row.parentElement;
  while (box !== null) {
    const overflow = getComputedStyle(box).overflowY;
    if (box.scrollHeight > box.clientHeight && (overflow === 'auto' || overflow === 'scroll'))
      break;
    box = box.parentElement;
  }
  const at = row.getBoundingClientRect();
  const mid = at.top + at.height / 2;
  if (box === null) {
    window.scrollBy({ top: mid - window.innerHeight / 2 });
    return;
  }
  const frame = box.getBoundingClientRect();
  box.scrollBy({ top: mid - (frame.top + frame.height / 2) });
}

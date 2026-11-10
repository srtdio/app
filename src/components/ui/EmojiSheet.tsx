// The emoji sheet: the one emoji drawer app-wide (the composer's emoji key,
// titled "Emoji", and every reaction's "+" / smiley, titled "Add reaction"). A default
// export, loaded with React.lazy on the first tap of the emoji button (nothing
// at mount). Built on ui/Sheet (floating layer: lit-overlay, the rise on phone
// and the grow on laptop come from the motion module through Sheet). Contents:
// a pill search field, "Frequently used" (the recents row from emoji-list.ts,
// read when the sheet opens and written on every pick, the same calls as
// chat/ComposerEmoji), then every curated group under its own name. A floating
// category bar at the bottom (Recent first, one icon per group) jumps to a
// group, instantly (never a smooth scroll). While a query is typed the results
// replace the grid; zero results show ui/NoResults. Static data only: no
// package, no network, no module-scope listeners. Tokens only, so light and
// dark stay at parity.

import { useEffect, useRef, useState } from 'react';
import type { ComponentType, ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { IconButton } from '@/components/ui/IconButton';
import { Input, SEARCH_ONE_CLEAR } from '@/components/ui/Input';
import { NoResults } from '@/components/ui/NoResults';
import { Text } from '@/components/ui/Text';
import {
  ICON_SIZE,
  IconBriefcase,
  IconClock,
  IconGift,
  IconHand,
  IconHeart,
  IconMusic,
  IconSmile,
  type IconProps,
} from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { EMOJI_LIST, readRecents, rememberRecent } from '@/lib/chat/emoji-list';
import { emojiLabel, searchEmoji } from '@/lib/chat/emoji-names';
import { EMOJI_GLYPH_TYPE } from '@/components/chat/chat-type';

/** The recents section's heading. */
export const RECENTS_HEADING = 'Frequently used';

/** The sheet's default title (its header and its dialog name); reactions pass "Add reaction". */
export const EMOJI_SHEET_TITLE = 'Emoji';

/** The recents section's key and its category tab name. */
const RECENT_KEY = 'Recent';

/** One category tab glyph per curated group (emoji-list.ts names). */
const GROUP_ICON: Readonly<Record<string, ComponentType<IconProps>>> = {
  [RECENT_KEY]: IconClock,
  Smileys: IconSmile,
  Gestures: IconHand,
  Hearts: IconHeart,
  Work: IconBriefcase,
  Media: IconMusic,
  Things: IconGift,
};

/** One section of the grid: a key (tab and jump target), its heading and glyphs. */
export interface EmojiSheetSection {
  key: string;
  heading: string;
  emoji: readonly string[];
}

/** The sections in order: recents first when there are any, then every group. Pure. */
export function emojiSheetSections(recents: readonly string[]): EmojiSheetSection[] {
  return [
    ...(recents.length > 0 ? [{ key: RECENT_KEY, heading: RECENTS_HEADING, emoji: recents }] : []),
    ...EMOJI_LIST.map((group) => ({ key: group.name, heading: group.name, emoji: group.emoji })),
  ];
}

/** A wrapping row of 44x44 glyph buttons. */
function EmojiGrid(props: {
  emoji: readonly string[];
  onPick: (emoji: string) => void;
}): ReactElement {
  return (
    <div className="flex flex-wrap">
      {props.emoji.map((emoji) => (
        <IconButton
          key={emoji}
          type="button"
          data-emoji-cell={emoji}
          label={emojiLabel(emoji)}
          onClick={() => props.onPick(emoji)}
          className={cn('shrink-0', EMOJI_GLYPH_TYPE)}
        >
          <span aria-hidden="true">{emoji}</span>
        </IconButton>
      ))}
    </div>
  );
}

export default function EmojiSheet(props: {
  open: boolean;
  onClose: () => void;
  onPick: (emoji: string) => void;
  closeOnPick: boolean;
  /** The header and dialog name; absent: "Emoji" (the composer's). */
  title?: string;
}): ReactElement {
  const { open, onClose, onPick, closeOnPick } = props;
  const [query, setQuery] = useState('');
  const [recents, setRecents] = useState<string[]>(() => (open ? readRecents() : []));
  const sectionRefs = useRef(new Map<string, HTMLElement>());

  // Each open shows the stored recents; each close drops the typed query.
  useEffect(() => {
    if (open) setRecents(readRecents());
    else setQuery('');
  }, [open]);

  function pick(emoji: string): void {
    setRecents(rememberRecent(emoji));
    onPick(emoji);
    if (closeOnPick) onClose();
  }

  function jumpTo(key: string): void {
    // Instant: the motion rules never smooth-scroll.
    sectionRefs.current.get(key)?.scrollIntoView?.({ block: 'start' });
  }

  const searching = query.trim() !== '';
  const sections = emojiSheetSections(recents);
  const results = searching ? searchEmoji(query, EMOJI_LIST) : [];

  return (
    <Sheet open={open} onClose={onClose} title={props.title ?? EMOJI_SHEET_TITLE} fixedHeight>
      {/* Phone: the sheet sizes to its content (capped at 90dvh), so the root
          keeps that open height while searching: results stay at the top
          under the field and never collapse behind the keyboard. */}
      <div data-emoji-sheet="" className="flex min-h-[90dvh] flex-col gap-4 sm:min-h-0">
        <Input
          type="text"
          inputMode="search"
          data-emoji-search=""
          aria-label="Search emoji"
          placeholder="Search emoji"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className={cn('rounded-full', SEARCH_ONE_CLEAR)}
        />
        {searching ? (
          results.length > 0 ? (
            <div data-emoji-results="">
              <EmojiGrid emoji={results} onPick={pick} />
            </div>
          ) : (
            <NoResults query={query} filtersActive={false} onClear={() => setQuery('')} />
          )
        ) : (
          <>
            <div className="flex flex-col gap-6">
              {sections.map((section) => (
                <section
                  key={section.key}
                  aria-label={section.heading}
                  data-emoji-section={section.key}
                  ref={(el) => {
                    if (el === null) sectionRefs.current.delete(section.key);
                    else sectionRefs.current.set(section.key, el);
                  }}
                  className="flex flex-col gap-2"
                >
                  <Text as="h3" role="section">
                    {section.heading}
                  </Text>
                  <EmojiGrid emoji={section.emoji} onPick={pick} />
                </section>
              ))}
            </div>
            {/* The floating category bar: it rides the bottom of the scroll
                body (sticky, clear of the home bar), a lifted pill
                (lit-float) as wide as its tabs. */}
            <nav
              aria-label="Emoji groups"
              data-emoji-categories=""
              className="sticky bottom-[max(8px,env(safe-area-inset-bottom))] z-sticky mx-auto flex w-fit items-center gap-1 rounded-full border bg-panel px-1 lit-float"
            >
              {sections.map((section) => {
                const Icon = GROUP_ICON[section.key] ?? IconSmile;
                return (
                  <IconButton
                    key={section.key}
                    type="button"
                    label={section.heading}
                    data-emoji-category={section.key}
                    onClick={() => jumpTo(section.key)}
                    className="rounded-full text-fg-2"
                  >
                    <Icon size={ICON_SIZE.control} />
                  </IconButton>
                );
              })}
            </nav>
          </>
        )}
      </div>
    </Sheet>
  );
}

// Personal notes' small pieces: the notebook glyph, the notes avatar (your
// photo with a notebook badge, or the accent-soft notebook square: chat home
// tile, thread header, forward picker, search rows), and the "Saved from"
// line a saved copy shows in place of "Forwarded". Tokens only, no motion.

import { createContext, useContext, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement, RefObject } from 'react';
import { cn } from '@/lib/cn';
import type { ThreadMessage } from '@/lib/chat/thread';
import type { SavedFromLine } from '@/lib/chat/saved-from';
import { IconNotePage } from '@/components/ui/icons';

/** The notebook glyph (stroke 1.7, like the icon set). */
export function NotesGlyph(props: { size?: number }): ReactElement {
  const size = props.size ?? 22;
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 3h10l3 3v15H6z" />
      <path d="M9 9h7M9 13h7M9 17h4" />
    </svg>
  );
}

/** The notes photo slot: 76px tile (radius 18), 40px header and 44px picker/search (radius 12). */
const NOTES_AVATAR_BOX = {
  tile: 'h-[76px] w-[76px] rounded-[18px]',
  header: 'h-10 w-10 rounded-[12px]',
  small: 'h-11 w-11 rounded-[12px]',
} as const;

export type NotesAvatarSize = keyof typeof NOTES_AVATAR_BOX;

const NOTES_GLYPH_SIZE: Record<NotesAvatarSize, number> = { tile: 34, header: 22, small: 24 };

/** The badge: 30px, -5px, 3px ring on the tile; 20px, -4px, 2px ring on small sizes. */
const NOTES_BADGE: Record<NotesAvatarSize, { box: string; glyph: number }> = {
  tile: { box: 'h-[30px] w-[30px] -bottom-[5px] -right-[5px] border-[3px]', glyph: 14 },
  header: { box: 'h-5 w-5 -bottom-1 -right-1 border-2', glyph: 10 },
  small: { box: 'h-5 w-5 -bottom-1 -right-1 border-2', glyph: 10 },
};

/** The surface behind the avatar: the badge ring takes it, so it cuts out cleanly. */
export type NotesAvatarSurface = 'panel' | 'panel-2' | 'bg' | 'accent-soft';

const RING: Record<NotesAvatarSurface, string> = {
  panel: 'border-panel',
  'panel-2': 'border-panel-2',
  bg: 'border-bg',
  'accent-soft': 'border-accent-soft',
};

/** The ring while the row is hovered (rows fill panel-2 on hover). */
const HOVER_RING: Record<'panel-2', string> = {
  'panel-2': 'group-hover/notes-row:border-panel-2',
};

/** Photo URLs that loaded this session: a later mount paints them on its first frame. */
const LOADED_PHOTOS = new Set<string>();

/** The accessible name the notes avatar keeps everywhere. */
export const NOTES_AVATAR_LABEL = 'Personal notes';

/**
 * The notes avatar: the signed-in user's own photo in the notes rounded
 * square with an accent notebook badge, or, with no photo (none set, still
 * loading, or failed), the accent-soft notebook square with no badge. The
 * photo is laid over the fallback in the same box and shows once loaded, so
 * nothing moves when it arrives; a failed photo stays on the fallback (never
 * a broken image, never initials). One component for the tile, the header,
 * the forward picker and search rows. No motion.
 */
export function NotesAvatar(props: {
  size: NotesAvatarSize;
  /** The user's own users.avatar_url; null or absent shows the notebook. */
  src?: string | null;
  surface?: NotesAvatarSurface;
  /**
   * The surface while its row (a `group/notes-row` ancestor) is hovered, so
   * the badge ring follows the row's hover fill.
   */
  hoverSurface?: 'panel-2';
}): ReactElement {
  const src = props.src ?? null;
  // Keyed by URL: a photo this session already showed paints on the first
  // frame; a new one starts unloaded; a failed one never retries.
  const [loaded, setLoaded] = useState<string | null>(() =>
    src !== null && LOADED_PHOTOS.has(src) ? src : null,
  );
  const [failed, setFailed] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const markLoaded = (url: string): void => {
    LOADED_PHOTOS.add(url);
    setLoaded(url);
  };
  // A cached photo (or a cached broken one) can settle before React wires
  // onLoad / onError: read it before paint.
  useLayoutEffect(() => {
    const img = imgRef.current;
    if (img === null || src === null || !img.complete) return;
    if (img.naturalWidth > 0) markLoaded(src);
    else setFailed(src);
  }, [src]);
  return notesAvatarView({
    size: props.size,
    src,
    loaded: src !== null && loaded === src,
    failed: src !== null && failed === src,
    surface: props.surface ?? 'panel',
    imgRef,
    onLoad: () => {
      if (src !== null) markLoaded(src);
    },
    onError: () => setFailed(src),
    ...(props.hoverSurface !== undefined ? { hoverSurface: props.hoverSurface } : {}),
  });
}

/**
 * The notes avatar for one photo state. Hook-free, so every state (no photo,
 * loading, loaded, failed) is unit tested: the photo sits over the notebook
 * in the same box and shows (with its badge) only once loaded.
 */
export function notesAvatarView(input: {
  size: NotesAvatarSize;
  src: string | null;
  loaded: boolean;
  failed: boolean;
  surface: NotesAvatarSurface;
  hoverSurface?: 'panel-2';
  imgRef?: RefObject<HTMLImageElement>;
  onLoad?: () => void;
  onError?: () => void;
}): ReactElement {
  const usable = input.src !== null && input.src !== '' && !input.failed;
  const shown = usable && input.loaded;
  const box = NOTES_AVATAR_BOX[input.size];
  const badge = NOTES_BADGE[input.size];
  return (
    <span
      role="img"
      aria-label={NOTES_AVATAR_LABEL}
      data-notes-avatar={shown ? 'photo' : 'notebook'}
      className={cn('relative flex shrink-0', box)}
    >
      <span
        className={cn(
          'flex h-full w-full items-center justify-center overflow-hidden bg-accent-soft text-accent',
          box,
        )}
      >
        {shown ? null : <NotesGlyph size={NOTES_GLYPH_SIZE[input.size]} />}
        {usable && input.src !== null ? (
          <img
            ref={input.imgRef}
            src={input.src}
            alt=""
            onLoad={input.onLoad}
            onError={input.onError}
            className={cn(
              'absolute inset-0 h-full w-full object-cover',
              box,
              shown ? 'opacity-100' : 'opacity-0',
            )}
          />
        ) : null}
      </span>
      {shown ? (
        <span
          aria-hidden="true"
          data-notes-badge=""
          className={cn(
            'absolute flex items-center justify-center rounded-full bg-accent text-accent-fg',
            badge.box,
            RING[input.surface],
            input.hoverSurface !== undefined && HOVER_RING[input.hoverSurface],
          )}
        >
          <NotesGlyph size={badge.glyph} />
        </span>
      ) : null}
    </span>
  );
}

/** What a notes thread's bubbles read for their "Saved from" line. */
export interface SavedFromWiring {
  lineFor: (message: ThreadMessage) => SavedFromLine | null;
  /** Open the source in its chat (the ?channel=&message= deep link). */
  onOpen: (line: Extract<SavedFromLine, { kind: 'source' }>) => void;
}

const SavedFromContext = createContext<SavedFromWiring | null>(null);

/** Provided around a notes thread only; every other chat reads null. */
export const SavedFromProvider = SavedFromContext.Provider;

export function useSavedFrom(): SavedFromWiring | null {
  return useContext(SavedFromContext);
}

/**
 * The line above a saved copy's body: "Saved from <chat> · <sender>", a 44px
 * tall link to the source, or the plain "Saved message" when the source can
 * no longer be read. Own and incoming inks, like "Forwarded".
 */
export function SavedFromLabel(props: {
  line: SavedFromLine;
  mine: boolean;
  onOpen: SavedFromWiring['onOpen'];
}): ReactElement {
  const { line } = props;
  const ink = props.mine ? 'text-accent-fg' : 'text-fg-2';
  const body = (
    <>
      <IconNotePage size={14} />
      <span className="min-w-0 truncate">{line.label}</span>
    </>
  );
  if (line.kind === 'unreadable') {
    return (
      <span
        data-saved-from="unreadable"
        className={cn('mb-1 flex items-center gap-1.5 text-md', ink)}
      >
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-saved-from="source"
      aria-label={`${line.label}, open the original message`}
      onClick={(event) => {
        event.stopPropagation();
        props.onOpen(line);
      }}
      className={cn(
        '-mb-2 -mt-3 flex min-h-[44px] max-w-full items-center gap-1.5 rounded-md text-left text-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        ink,
      )}
    >
      {body}
    </button>
  );
}

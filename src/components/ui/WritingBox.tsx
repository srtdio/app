// The one writing box (Slack style) for every multi-line writing surface:
// chat, comments, sheet fields and the post caption. It wraps the caller's
// field (ui/Textarea or comments/MentionInput, borderless inside) and draws
// the rows around it. Modes:
//
//   chat     phone: an idle pill (+, "Message", mic) that becomes the card on
//            focus or with a draft; laptop / iPad: always the card.
//   comment  the card always; the row shows while focused or holding text.
//   field    looks like a plain field until focused; then the Aa row sits
//            inside its bottom edge (no +, no send, no X).
//   caption  emoji and a plain "@" only; no formatting of any kind.
//
// restPill (the catch-up reply): chat or comment rests as the pill on every
// layout. `attachments` (a kept voice note, files) wait inside the open card
// above the text. While recording, a caller's `recording` row (chat/VoiceDraft
// RecordingRow) fills the pill in place of the field and keys.
//
// The card's bottom row: + , Aa, emoji, @ ... mic, send. The mic sits beside
// send in every state, typing included. Aa swaps the row for the format row.
// Laptop: Aa (on: pressed again it closes the row), Bold, Italic, Underline,
// Strike, Link, Numbered list, Bullet list, Quote ... mic, send. Phone card
// (8 Nov 2026): X close (a filled circle matching send), Bold, Italic,
// Underline, Strike, Link, Numbered list, Bullet list, send, spread evenly; no
// Aa, no Quote, no mic while open. Selecting text in the phone card opens the
// row; collapsing the selection closes it again unless Aa opened it (then it
// stays until X). Keys rest in fg-2; a key is "on" (the glyph turns ink, fg;
// never a tile, ring or fill) while the caret or selection sits inside that
// style. Formatting is WYSIWYG (ui/Textarea and
// comments/MentionInput hide the markers, src/lib/format-live.ts).
//
// The + tray (chat/ComposerTray) opens as the top of this same box: one
// outline around tray and text, the same fill, in flow (the thread above
// lifts, nothing is covered). The tray reaches its slot through
// WritingTrayContext (ui/writing-tray.ts).
//
// Expand (every mode): a quiet IconExpand top-right while focused or holding
// text. Phone: the same box becomes a full-screen editor pinned to the top of
// the visible screen, its row on the keyboard (the field never remounts, so
// the text, caret, reply bars and attachments stay); laptop: the box grows in
// place. One collapse key (the editor's top bar) or Esc returns it; Send
// closes it.
//
// Focused, the box keeps itself above the on-screen keyboard (the caret line
// with it) after each size change.
//
// Speed: pure render at mount. The emoji sheet and Add link sheet load on the
// first tap (React.lazy); the visual viewport is read only while expanded on
// a phone or focused; selectionchange is listened to only while the format
// row is open or a phone card is focused.

import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactElement, ReactNode } from 'react';
import { ComposerFrame, type ComposerState } from '@/components/ui/Composer';
import {
  ICON_SIZE,
  IconAt,
  IconBold,
  IconCollapse,
  IconExpand,
  IconItalic,
  IconLink,
  IconListBullet,
  IconListNumbered,
  IconQuote,
  IconSmile,
  IconStrike,
  IconUnderline,
  IconX,
} from '@/components/ui/icons';
import { ProgressRing } from '@/components/ui/ProgressRing';
import { textRole } from '@/components/ui/Text';
import {
  activeActions,
  applyAction,
  fieldSelection,
  insertText,
  restoreSelection,
  shortcutAction,
  type Field,
  type FormatAction,
} from '@/components/ui/format-actions';
import { cn } from '@/lib/cn';
import { MOVE_CLASS } from '@/lib/motion';
import { useIsLaptop } from '@/lib/use-is-laptop';
import { WritingTrayContext, type WritingTray } from '@/components/ui/writing-tray';

const EmojiSheet = lazy(() => import('@/components/ui/EmojiSheet'));
const AddLinkSheet = lazy(() => import('@/components/ui/AddLinkSheet'));

const noSubscribe = (): (() => void) => () => undefined;
const isBrowser = (): boolean => true;
const isServer = (): boolean => false;

export type WritingMode = 'chat' | 'comment' | 'field' | 'caption';

/** The format row, in order; aria-labels are the button names. */
export const FORMAT_KEYS: readonly {
  action: FormatAction;
  label: string;
  icon: (p: { size: number }) => ReactNode;
}[] = [
  { action: 'bold', label: 'Bold', icon: (p) => <IconBold {...p} /> },
  { action: 'italic', label: 'Italic', icon: (p) => <IconItalic {...p} /> },
  { action: 'underline', label: 'Underline', icon: (p) => <IconUnderline {...p} /> },
  { action: 'strike', label: 'Strike', icon: (p) => <IconStrike {...p} /> },
  { action: 'link', label: 'Link', icon: (p) => <IconLink {...p} /> },
  { action: 'ol', label: 'Numbered list', icon: (p) => <IconListNumbered {...p} /> },
  { action: 'ul', label: 'Bullet list', icon: (p) => <IconListBullet {...p} /> },
  { action: 'quote', label: 'Quote', icon: (p) => <IconQuote {...p} /> },
];

/** Room left between a revealed box and the keyboard (px, the 12 step). */
const REVEAL_GAP_PX = 12;

/**
 * The visible band of the screen while `active` (the phone editor): its top
 * (the layout viewport can sit scrolled under an iOS keyboard) and how far
 * the keyboard covers the bottom. Read from visualViewport only while active;
 * zeros otherwise, so nothing is read at mount.
 */
export function visibleBandOf(
  innerHeight: number,
  vv: { height: number; offsetTop: number } | null | undefined,
): { top: number; bottom: number } {
  if (vv === null || vv === undefined) return { top: 0, bottom: 0 };
  const top = Math.max(0, Math.round(vv.offsetTop));
  const bottom = Math.round(innerHeight - vv.height - vv.offsetTop);
  // Sub-pixel and browser-bar jitter is not a keyboard.
  return { top, bottom: bottom > 40 ? bottom : 0 };
}

function useVisibleBand(active: boolean): { top: number; bottom: number } {
  const [band, setBand] = useState({ top: 0, bottom: 0 });
  // Before paint on opening, as the keyboard inset was: the editor never
  // shows one frame under the keyboard.
  useLayoutEffect(() => {
    if (!active || typeof window === 'undefined') {
      setBand({ top: 0, bottom: 0 });
      return undefined;
    }
    const vv = window.visualViewport ?? null;
    const update = (): void => setBand(visibleBandOf(window.innerHeight, vv));
    update();
    if (vv === null) return undefined;
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [active]);
  return band;
}

/** Scroll the box's nearest scrolling ancestor (else the page) down by `dy`. */
function scrollUpBy(el: HTMLElement, dy: number): void {
  for (let at = el.parentElement; at !== null; at = at.parentElement) {
    const oy = window.getComputedStyle(at).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && at.scrollHeight > at.clientHeight) {
      at.scrollTop += dy;
      return;
    }
  }
  window.scrollBy(0, dy);
}

/** Keep the field focused (and the keyboard up) when a row key is pressed. */
function keepFocus(e: PointerEvent | MouseEvent): void {
  e.preventDefault();
}

/**
 * A row key's 36 slot held empty (aria-hidden): a state that hides a key (the
 * mic while a voice note sends) keeps the row's width (states keep their
 * footprint).
 */
export function RowKeyHold(): ReactElement {
  return <span aria-hidden="true" data-row-key-hold="" className="inline-flex h-11 w-9 shrink-0" />;
}

/**
 * A composer row key: 36 visual circle, 44 tall hit (the composer-row 36
 * spacing exception, CLAUDE.md; guard src/__tests__/composer-row-keys.test.ts).
 */
export function RowKey({
  label,
  on = false,
  solid = false,
  onPress,
  children,
  className,
  ...rest
}: {
  label: string;
  on?: boolean;
  solid?: boolean;
  onPress: () => void;
  children: ReactNode;
  className?: string;
  'data-row-key'?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on ? true : undefined}
      data-composer-key=""
      className={cn(
        'inline-flex h-11 w-9 shrink-0 items-stretch py-1 rounded-full focus-visible:lit-focus',
        MOVE_CLASS.press,
        className,
      )}
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
      onClick={onPress}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex w-full items-center justify-center rounded-full',
          MOVE_CLASS.tint,
          // On: the glyph turns ink (fg), never a tile, ring or fill; at rest
          // every key is the one grey (fg-2). Solid: the phone format row's
          // close, the same filled circle as RowSend.
          solid ? 'bg-accent text-accent-fg' : on ? 'text-fg' : 'text-fg-2 lit-hover',
        )}
      >
        {children}
      </span>
    </button>
  );
}

/**
 * The card's send: a 36 circle (44 tall hit), solid ink always (nothing to
 * send: it takes no tap, and stays ink); busy keeps its place with the
 * turning arc.
 */
export function RowSend({
  label,
  disabled,
  busy = false,
  icon,
  onClick,
  type = 'submit',
  ...rest
}: {
  label: string;
  disabled: boolean;
  busy?: boolean;
  icon: ReactNode;
  onClick?: () => void;
  type?: 'submit' | 'button';
  onPointerDown?: (e: PointerEvent<HTMLButtonElement>) => void;
  onMouseDown?: (e: MouseEvent<HTMLButtonElement>) => void;
  onTouchEnd?: () => void;
  /** A tour key handed in by the composer (sendAnchor); absent: none. */
  'data-induction'?: string | undefined;
}) {
  return (
    <button
      type={type}
      aria-label={label}
      aria-busy={busy ? true : undefined}
      disabled={disabled || busy}
      data-row-send=""
      className={cn(
        'inline-flex h-11 w-9 shrink-0 items-stretch py-1 rounded-full focus-visible:lit-focus disabled:pointer-events-none',
        MOVE_CLASS.press,
      )}
      onClick={onClick}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cn(
          'grid w-full place-items-center rounded-full',
          MOVE_CLASS.tint,
          'bg-accent text-accent-fg',
        )}
      >
        {busy ? (
          <ProgressRing
            progress={null}
            size={16}
            stroke={2}
            arc={0.25}
            className={cn('h-4 w-4', MOVE_CLASS.spin)}
            trackClass="text-transparent"
            arcClass="text-current"
          />
        ) : (
          icon
        )}
      </span>
    </button>
  );
}

/** A field-shape box whose field is switched off: the grey edge, never the ink line. */
export const WRITING_FIELD_DISABLED = 'has-[textarea:disabled]:border-border-strong';

// The field inside the box drops its own look: the box draws the line, the
// fill and the focus line. Tokens only.
// Phone (12 Nov 2026): the field is a block, so no line-box gap sits under it
// (it made the box 6 taller than its 44 keys: the words rode 3 above the row's
// centre and a bottom-aligned Send 3 below it).
const BOX_OWNS_FIELD =
  '[&_textarea]:border-0 [&_textarea]:bg-transparent [&_textarea]:px-0 [&_textarea]:[--lit-well:none] [&_textarea]:[--sel-edge:transparent] max-md:[&_textarea]:block';

export interface WritingBoxProps {
  mode: WritingMode;
  /** The field the rows act on (a textarea or a contentEditable). */
  field: () => Field | null;
  /** The field node itself. */
  input: ReactNode;
  /** The field holds text (or a draft attachment, for chat). */
  hasText: boolean;
  /** The + (ComposerTray), where the box has attach today. */
  leading?: ReactNode;
  /** The card's trailing slot: send (laptop chat: mic while empty). */
  send?: ReactNode;
  /** Chat on a phone: the idle pill's trailing mic. */
  pillEnd?: ReactNode;
  /**
   * The mic key: beside send in every state (typing included), and the idle
   * pill's trailing key when no pillEnd is given.
   */
  mic?: ReactNode;
  /**
   * Lists that open over the text (chat's @ and # pickers, positioned
   * absolute bottom-full): anchored above the box at rest, above the row
   * inside the full-screen phone editor.
   */
  overlay?: ReactNode;
  /** "@": types "@" at the caret (the field opens its own mention list). */
  mention?: boolean;
  /** Insert text where the caret was (MentionInput keeps its own caret). */
  onInsert?: (text: string) => void;
  /** The expanded editor's title (chat: name and role line; fields: the label). */
  expandTitle?: ReactNode;
  /** Bars above the box (reply, About, edit, private reply), unchanged. */
  strip?: ReactNode;
  /** Chat recording / sending. */
  state?: ComposerState;
  /**
   * While recording: the row the pill holds in place of the field and keys
   * (chat/VoiceDraft RecordingRow: X cancel, the live track, m:ss, check).
   * Absent: the older ComposerFrame recording row (dot, "Recording", m:ss,
   * discard, send).
   */
  recording?: ReactNode;
  /** The older recording row's bin (ComposerFrame); unused with `recording`. */
  discard?: ReactNode;
  /**
   * What waits inside the open box above the text (a kept voice note, picked
   * files): shown in the card, and holding the card open while present.
   */
  attachments?: ReactNode;
  /**
   * Rest as the pill (+, the hint centred, the mic for chat) on every layout
   * and in comment mode too (the catch-up reply); focus, text or an
   * attachment opens the card as usual.
   */
  restPill?: boolean;
  /** Laptop: the card always (chat), ignoring the phone pill. Defaults to useIsLaptop. */
  laptop?: boolean;
  className?: string;
  /** Field / caption: the field is invalid (the box's edge reads bad, as the field's did). */
  invalid?: boolean;
  /** Field mode: the box's own min height class (as the field had). */
  'data-surface'?: string;
}

export function WritingBox(props: WritingBoxProps) {
  const {
    mode,
    field,
    input,
    hasText,
    leading,
    send,
    pillEnd,
    mic,
    overlay,
    mention = false,
    onInsert,
    expandTitle,
    strip,
    state = { kind: 'idle' },
    recording,
    discard,
    attachments,
    restPill = false,
    className,
    invalid = false,
  } = props;
  const hasAttachments = attachments !== undefined && attachments !== null && attachments !== false;
  const isLaptopHook = useIsLaptop();
  const laptop = props.laptop ?? isLaptopHook;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(false);
  // A blur collapses the box only after the press that caused it has landed:
  // collapsing on pointerdown would move what the finger is on (the button
  // under the box) before its click. Bumped by every focus to drop a stale one.
  const blurToken = useRef(0);
  // The pending blur's cleanup: an unmount cancels its timers and listener so
  // no collapse lands after the box is gone.
  const blurCancel = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      blurToken.current += 1;
      blurCancel.current?.();
    },
    [],
  );
  const [formatOpen, setFormatOpen] = useState(false);
  // Aa opened the row (it then stays until closed); a selection's row closes
  // when the selection collapses.
  const openedByAa = useRef(false);
  const [on, setOn] = useState<ReadonlySet<FormatAction>>(() => new Set());
  const [expanded, setExpanded] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiLoaded, setEmojiLoaded] = useState(false);
  const [link, setLink] = useState<{ text: string; start: number; end: number } | null>(null);
  const [linkLoaded, setLinkLoaded] = useState(false);
  const formatting = mode !== 'caption';
  const phoneExpanded = expanded && !laptop;
  const band = useVisibleBand(phoneExpanded);
  // The + tray: open here (so the + can move between pill and card and keep
  // it), drawn by ComposerTray into the slot at the top of the box.
  const [trayOpen, setTrayOpen] = useState(false);
  const [traySlot, setTraySlot] = useState<HTMLDivElement | null>(null);
  const tray = useMemo<WritingTray>(
    () => ({ open: trayOpen, setOpen: setTrayOpen, slot: traySlot }),
    [trayOpen, traySlot],
  );

  const refreshOn = useCallback((): void => {
    const el = field();
    if (el === null) return;
    setOn(activeActions(el));
  }, [field]);

  // Focus grows the box (its row of keys appears under the text) and so does
  // a new line: the browser only reveals the caret, so the row could sit under
  // a bottom bar, the screen edge or the on-screen keyboard. While focused,
  // each size change (and each keyboard move) brings the whole box into view
  // on the next frame (nearest: no move when it already shows; scroll-mb keeps
  // it above the post page's decision bar). The layout viewport does not
  // shrink for an iOS keyboard, so the box is then lifted by whatever the
  // visible band still leaves under the keyboard: the whole box, or for a box
  // taller than half the band, its bottom row (the caret line sits over it).
  // A scroll after paint, never a hold on the tap. Never while a range is
  // selected or a finger / pointer is down on the box (selecting resizes the
  // iOS keyboard; a move then would grow the selection under the finger). A
  // tall box lifts its bottom row only while the caret is at the end of the
  // text; anywhere else the browser reveals the caret itself.
  const fieldRef = useRef(field);
  fieldRef.current = field;
  useEffect(() => {
    if (!focused || phoneExpanded) return undefined;
    const el = rootRef.current;
    if (el === null || typeof el.scrollIntoView !== 'function') return undefined;
    const vv = typeof window !== 'undefined' ? (window.visualViewport ?? null) : null;
    let raf = 0;
    let pressed = false;
    const reveal = (): void => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        if (pressed) return;
        const f = fieldRef.current();
        const sel = f !== null ? fieldSelection(f) : null;
        if (sel !== null && sel.start !== sel.end) return;
        const top = vv?.offsetTop ?? 0;
        const bottom = vv !== null ? vv.offsetTop + vv.height : window.innerHeight;
        if (el.getBoundingClientRect().height <= (bottom - top) / 2) {
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } else if (sel === null || sel.end !== sel.text.length) {
          return;
        }
        const over = el.getBoundingClientRect().bottom - bottom + REVEAL_GAP_PX;
        if (over > 0) scrollUpBy(el, over);
      });
    };
    const down = (): void => {
      pressed = true;
      window.cancelAnimationFrame(raf);
    };
    const up = (): void => {
      pressed = false;
    };
    reveal();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(reveal) : null;
    ro?.observe(el);
    vv?.addEventListener('resize', reveal);
    el.addEventListener('pointerdown', down, { passive: true });
    el.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('touchend', up);
    window.addEventListener('touchcancel', up);
    return () => {
      window.cancelAnimationFrame(raf);
      ro?.disconnect();
      vv?.removeEventListener('resize', reveal);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('touchstart', down);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('touchend', up);
      window.removeEventListener('touchcancel', up);
    };
  }, [focused, phoneExpanded]);

  // The phone card: a selection in the field opens the format row.
  const selectionOpens =
    formatting && !laptop && focused && (mode === 'chat' || mode === 'comment');

  // While the format row is open, follow the caret (contentEditable has no
  // select event of its own); while a phone card is focused, a selection opens
  // the row and its collapse closes it (unless Aa opened it). Only then:
  // nothing is listened to at mount.
  useEffect(() => {
    if (!formatOpen && !selectionOpens) return undefined;
    const onChange = (): void => {
      if (selectionOpens) {
        const el = field();
        if (el === null) return;
        const active = document.activeElement;
        const inField = active !== null && (el === active || el.contains(active));
        const { start, end } = fieldSelection(el);
        if (inField && start !== end) {
          setFormatOpen(true);
        } else if (!openedByAa.current) {
          setFormatOpen(false);
          return;
        }
      }
      refreshOn();
    };
    document.addEventListener('selectionchange', onChange);
    if (formatOpen) refreshOn();
    return () => document.removeEventListener('selectionchange', onChange);
  }, [formatOpen, selectionOpens, field, refreshOn]);

  const openFormat = (): void => {
    openedByAa.current = true;
    setFormatOpen(true);
  };
  const closeFormat = (): void => {
    openedByAa.current = false;
    setFormatOpen(false);
  };

  const insert = useCallback(
    (text: string): void => {
      if (onInsert !== undefined) {
        onInsert(text);
        return;
      }
      const el = field();
      if (el !== null) insertText(el, text);
    },
    [field, onInsert],
  );

  const openLink = useCallback((): void => {
    const el = field();
    if (el === null) return;
    const sel = fieldSelection(el);
    setLinkLoaded(true);
    setLink({ text: sel.text.slice(sel.start, sel.end), start: sel.start, end: sel.end });
  }, [field]);

  const runAction = useCallback(
    (action: FormatAction): void => {
      if (action === 'link') {
        openLink();
        return;
      }
      const el = field();
      if (el === null) return;
      applyAction(el, action);
      refreshOn();
    },
    [field, openLink, refreshOn],
  );

  const mentionKey = (): void => {
    const el = field();
    let lead = '';
    if (el !== null) {
      const { text, start } = fieldSelection(el);
      const before = text[start - 1] ?? '';
      if (before !== '' && !/\s/.test(before)) lead = ' ';
    }
    insert(`${lead}@`);
  };

  const onKeyDownCapture = (e: KeyboardEvent): void => {
    if (expanded && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setExpanded(false);
      return;
    }
    if (!formatting) return;
    if (shortcutAction(e) === 'link') {
      e.preventDefault();
      openLink();
    }
  };

  // The box renders into one stable host node, so React never remounts the
  // field. Collapsed, the host sits in place (a display: contents slot);
  // expanded on a phone it moves to <body>, so no transformed or clipping
  // ancestor (page slides, sheets, overflow) can trap or cut the full-screen
  // editor. Moving the node keeps the text, caret, bars and attachments.
  const [host] = useState<HTMLDivElement | null>(() => {
    // No DOM (a server render, a test's stub document): the box renders in place.
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      return null;
    }
    const node = document.createElement('div');
    node.style.display = 'contents';
    node.dataset.writingHost = '';
    return node;
  });
  // A server render (static markup) has no portals: the box renders in place.
  const inBrowser = useSyncExternalStore(noSubscribe, isBrowser, isServer);
  const slotNode = useRef<HTMLDivElement | null>(null);
  const expandedOnPhone = useRef(false);
  expandedOnPhone.current = phoneExpanded;
  // Attached before the box's own children commit, so an autoFocus field is
  // already in the document when it focuses.
  const slotRef = useCallback(
    (slot: HTMLDivElement | null): void => {
      slotNode.current = slot;
      if (slot !== null && host !== null && !expandedOnPhone.current && host.parentNode !== slot) {
        slot.appendChild(host);
      }
    },
    [host],
  );
  useLayoutEffect(() => {
    if (host === null) return;
    const target = phoneExpanded ? (document.body ?? null) : slotNode.current;
    if (target === null || host.parentNode === target) return;
    const el = field();
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const sel = el !== null && active !== null && el.contains(active) ? fieldSelection(el) : null;
    target.appendChild(host);
    if (el !== null && sel !== null) restoreSelection(el, sel.start, sel.end);
    // The live format mirror follows the field's new size (Textarea listens).
    window.dispatchEvent(new Event('resize'));
  }, [phoneExpanded, host, field]);
  // Only the phone editor's spot on <body> needs a cleanup: in its slot the box
  // leaves with the slot. Never detached from its slot here, so a remount of
  // effects (Strict Mode) does not blur an autoFocus field.
  useEffect(
    () => () => {
      if (host !== null && host.parentNode !== null && host.parentNode === document.body) {
        host.parentNode.removeChild(host);
      }
    },
    [host],
  );

  // Send closes the format row and the expanded editor (Slack keeps neither).
  // On a phone the box goes back into its form first, so the send button's
  // own submit still reaches the form.
  const onSendCapture = (): void => {
    closeFormat();
    if (!expanded) return;
    const slot = slotNode.current;
    if (!laptop && host !== null && slot !== null && host.parentNode !== slot) {
      slot.appendChild(host);
    }
    setExpanded(false);
  };

  if (state.kind === 'recording' && recording !== undefined && recording !== null) {
    // Recording: the pill holds the caller's recording row (X cancel, the live
    // track, m:ss, check), the strip stays above. The field is not drawn; its
    // text lives with the caller and comes back after.
    return (
      <div
        data-writing-box=""
        data-mode={mode}
        data-shape="recording"
        data-composer=""
        data-composer-state="recording"
        className={cn(
          'relative flex w-full min-w-0 max-w-full flex-col gap-2 [contain:inline-size]',
          className,
        )}
      >
        {strip !== undefined && strip !== null ? (
          <div data-composer-strip="" className="flex min-w-0 flex-col gap-2 empty:hidden">
            {strip}
          </div>
        ) : null}
        <div
          data-writing-frame=""
          data-writing-recording=""
          className="lit-well flex min-h-11 min-w-0 max-w-full items-center overflow-x-clip rounded-full border bg-panel-2"
        >
          {recording}
        </div>
      </div>
    );
  }

  if (state.kind === 'recording') {
    // No recording row given: the older row (dot, "Recording", m:ss, bin, stop).
    return (
      <ComposerFrame
        input={input}
        strip={strip}
        state={state}
        discard={discard}
        send={send}
        {...(className !== undefined ? { className } : {})}
      />
    );
  }

  const shape: 'pill' | 'line' | 'card' | 'field' =
    mode === 'field' || mode === 'caption'
      ? 'field'
      : expanded ||
          formatOpen ||
          focused ||
          hasText ||
          hasAttachments ||
          trayOpen ||
          state.kind !== 'idle'
        ? 'card'
        : restPill || (mode === 'chat' && !laptop)
          ? 'pill'
          : mode === 'chat'
            ? 'card'
            : 'line';
  const rowShown =
    shape === 'card' || (shape === 'field' && (focused || expanded || emojiOpen || link !== null));
  // One collapse sign: the phone editor's top bar has it, so the in-box key
  // hides there.
  const showExpand = shape !== 'pill' && !phoneExpanded && (focused || hasText || expanded);

  const emojiKey = (
    <RowKey
      label="Emoji"
      onPress={() => {
        setEmojiLoaded(true);
        setEmojiOpen(true);
      }}
    >
      <IconSmile size={ICON_SIZE.control} />
    </RowKey>
  );
  const atKey = mention ? (
    <RowKey label="Mention" onPress={mentionKey}>
      <IconAt size={ICON_SIZE.control} />
    </RowKey>
  ) : null;

  // The phone card's format row: X close and send (matching filled circles)
  // at the ends, the keys spread evenly between; no Aa, no Quote, no mic.
  const phoneFormat = shape === 'card' && !laptop;
  const formatKeys = phoneFormat ? FORMAT_KEYS.filter((k) => k.action !== 'quote') : FORMAT_KEYS;
  const sendKey =
    send !== undefined ? (
      <span className="flex shrink-0" onClickCapture={onSendCapture}>
        {send}
      </span>
    ) : null;

  const formatRow = (
    <div
      data-format-row=""
      role="toolbar"
      aria-label="Format"
      className={cn(
        'flex min-w-0 flex-1 items-center overflow-x-auto',
        phoneFormat && 'justify-between',
      )}
    >
      {phoneFormat ? (
        <RowKey label="Close formatting" solid data-row-key="close" onPress={closeFormat}>
          <IconX size={ICON_SIZE.inline} />
        </RowKey>
      ) : shape === 'card' ? (
        // Laptop: Aa closes its own row (on while open).
        <RowKey label="Aa" on data-row-key="aa" onPress={closeFormat}>
          <span className={textRole('label')}>Aa</span>
        </RowKey>
      ) : null}
      {formatKeys.map((k) => (
        <RowKey
          key={k.action}
          label={k.label}
          on={on.has(k.action)}
          data-row-key={k.action}
          onPress={() => runAction(k.action)}
        >
          {k.icon({ size: ICON_SIZE.control })}
        </RowKey>
      ))}
    </div>
  );

  const actionRow = (
    <div data-action-row="" className="flex min-w-0 flex-1 items-center">
      {shape === 'card' ? leading : null}
      {formatting ? (
        <RowKey label="Aa" data-row-key="aa" onPress={openFormat}>
          <span className={textRole('label')}>Aa</span>
        </RowKey>
      ) : null}
      {emojiKey}
      {atKey}
    </div>
  );

  // Field mode keeps its keys on one row: Aa row (formatting) or emoji / @.
  const fieldRow = (
    <div className="flex min-w-0 flex-1 items-center">
      {formatting ? formatRow : null}
      {emojiKey}
      {atKey}
    </div>
  );

  const overlayInEditor =
    phoneExpanded && overlay !== undefined && overlay !== null ? (
      <div data-writing-overlay="" className="relative">
        {overlay}
      </div>
    ) : null;

  // The trailing keys: the mic beside send, in every state (typing too). The
  // phone format row hides the mic; send never moves (Send closes the row in
  // its click capture, and a send remounted elsewhere would drop the submit).
  const micShown = !(formatOpen && phoneFormat);
  const trailing =
    send !== undefined || (micShown && mic !== undefined && mic !== null) ? (
      <span data-row-trailing="" className="flex shrink-0 items-center">
        {micShown ? mic : null}
        {sendKey}
      </span>
    ) : null;

  const row = rowShown ? (
    <div data-writing-row="" className="flex min-h-11 min-w-0 items-center gap-2">
      {shape === 'field' ? fieldRow : formatOpen ? formatRow : actionRow}
      {shape === 'card' ? trailing : null}
    </div>
  ) : null;

  const expandKey = showExpand ? (
    <RowKey
      label={expanded ? 'Collapse' : 'Expand'}
      className="self-start"
      onPress={() => setExpanded((x) => !x)}
    >
      {expanded ? (
        <IconCollapse size={ICON_SIZE.control} />
      ) : (
        <IconExpand size={ICON_SIZE.control} />
      )}
    </RowKey>
  ) : null;

  // overflow-x-clip: nothing inside (a long word, a chip, a key) can make the
  // box wider than its place. The card's focus line (and the open tray's)
  // draws just inside its edge (lit-focus-inset), so no parent's edge or
  // overflow can cut it on the left or right: one continuous ink line around
  // the tray and the text.
  const frameClass = cn(
    'flex min-w-0 max-w-full overflow-x-clip border bg-panel-2',
    BOX_OWNS_FIELD,
    shape === 'pill' && 'min-h-11 items-center gap-2 rounded-full pl-1 pr-1',
    shape === 'line' &&
      cn('min-h-11 items-end gap-2 rounded-2xl pr-1', leading != null ? 'pl-1' : 'pl-3'),
    shape === 'card' &&
      cn(
        'flex-col rounded-2xl px-3 py-1 focus-within:lit-focus-inset',
        trayOpen && 'lit-focus-inset',
      ),
    shape === 'field' &&
      cn(
        'lit-well flex-col rounded-lg px-3 focus-within:lit-focus',
        invalid ? 'border-bad lit-bad' : 'border-field',
        // Switched off (11 Nov 2026): the field's ink line drops to the grey edge.
        WRITING_FIELD_DISABLED,
      ),
    phoneExpanded && 'flex-1 rounded-none border-0',
  );

  const box = (
    <div
      data-writing-frame=""
      data-invalid={invalid ? '' : undefined}
      className={frameClass}
      onFocus={(e) => {
        // Only the field itself opens the card: focusing the + (or any row
        // key) in the pill must not move it, or its tray would remount closed.
        // The field itself (an autoFocus field may focus before its ref is
        // set): anything in the field area except a key (Expand).
        const t = e.target;
        const inField =
          t instanceof Element &&
          t.closest('[data-writing-field]') !== null &&
          t.closest('button') === null;
        if (inField) {
          blurToken.current += 1;
          setFocused(true);
        }
      }}
      onBlur={(e) => {
        const next = e.relatedTarget;
        if (next instanceof Node && e.currentTarget.contains(next)) return;
        const token = ++blurToken.current;
        let timer = 0;
        let settle = 0;
        blurCancel.current?.();
        const cancel = (): void => {
          document.removeEventListener('pointerup', done, true);
          window.clearTimeout(timer);
          window.clearTimeout(settle);
        };
        function done(): void {
          document.removeEventListener('pointerup', done, true);
          window.clearTimeout(timer);
          // After the click that follows this pointerup (same task).
          settle = window.setTimeout(() => {
            if (blurToken.current === token) setFocused(false);
          }, 0);
        }
        blurCancel.current = cancel;
        // Listened to only between a blur and its press ending; a keyboard
        // blur (no press) collapses on the fallback.
        document.addEventListener('pointerup', done, true);
        timer = window.setTimeout(done, 200);
      }}
      onKeyUp={formatOpen ? refreshOn : undefined}
      onMouseUp={formatOpen ? refreshOn : undefined}
    >
      {/* The + tray's slot: the top of this same box (ComposerTray draws into it). */}
      <div ref={setTraySlot} data-writing-tray-slot="" className="min-w-0 empty:hidden" />
      {/* What waits in the open box (a kept voice note, files), above the text. */}
      {shape === 'card' && hasAttachments ? (
        <div data-writing-attachments="" className="flex min-w-0 flex-wrap gap-2 pt-2">
          {attachments}
        </div>
      ) : null}
      {/* The + at rest: the chat pill and the comment line keep it beside the field. */}
      {shape === 'pill' || shape === 'line' ? leading : null}
      <div
        data-writing-field=""
        className={cn('flex min-w-0 flex-1 items-start', phoneExpanded && 'min-h-0')}
      >
        <div className={cn('min-w-0 flex-1 self-center', phoneExpanded && 'h-full self-stretch')}>
          {input}
        </div>
        {expandKey}
      </div>
      {shape === 'pill' ? (pillEnd ?? mic) : null}
      {shape === 'line' ? trailing : null}
      {/* A comment's @ list (MentionInput) hangs here: on the box at rest, above
          the row in the phone editor, exactly where chat's pickers sit. */}
      <div data-writing-list-slot="" className={phoneExpanded ? 'relative' : 'contents'} />
      {overlayInEditor}
      {row}
    </div>
  );

  const content = (
    <WritingTrayContext.Provider value={tray}>
      <div
        ref={rootRef}
        data-writing-box=""
        data-mode={mode}
        data-shape={shape}
        data-expanded={expanded ? (laptop ? 'laptop' : 'phone') : undefined}
        data-composer=""
        data-composer-state={state.kind}
        onKeyDownCapture={onKeyDownCapture}
        className={cn(
          // contain inline-size: the box always takes its container's width and
          // never sizes the page to its rows (the Aa row is wider than a phone:
          // it scrolls inside the box instead of pushing the chat off screen).
          'flex w-full min-w-0 max-w-full flex-col gap-2 [contain:inline-size]',
          // Revealed clear of a bottom bar the page names (the post page's phone
          // decision bar sets --focus-inset-bottom), like a linked comment row.
          'scroll-mb-[calc(var(--focus-inset-bottom,0px)+0.75rem)]',
          !phoneExpanded && 'relative',
          // The phone editor: pinned to the top of the visible screen, its row
          // on the keyboard.
          phoneExpanded && 'fixed inset-x-0 z-sheet bg-panel px-3 pb-2 lit-overlay',
          className,
        )}
        style={phoneExpanded ? { top: band.top, bottom: band.bottom } : undefined}
      >
        {phoneExpanded ? null : overlay}
        {phoneExpanded ? (
          <div
            data-expanded-bar=""
            // The key's box sits on 16 and the title on the 64 column (12 + 4 + 36 + 12).
            className="wb-safe-top flex min-h-11 items-center gap-2 max-md:gap-3 max-md:pl-1"
          >
            <RowKey label="Collapse" onPress={() => setExpanded(false)}>
              <IconCollapse size={ICON_SIZE.control} />
            </RowKey>
            <span className={textRole('title', 'min-w-0 flex-1 truncate')}>{expandTitle}</span>
          </div>
        ) : null}
        {strip !== undefined && strip !== null ? (
          <div data-composer-strip="" className="flex min-w-0 flex-col gap-2 empty:hidden">
            {strip}
          </div>
        ) : null}
        {box}
        {/* The sheets are portalled, but React events still bubble through the
            box's own tree: the Add link sheet's submit must never reach the chat
            composer's <form> (it would send the half-written message). */}
        <div data-writing-sheets="" className="contents" onSubmit={(e) => e.stopPropagation()}>
          {emojiLoaded ? (
            <Suspense fallback={null}>
              <EmojiSheet
                open={emojiOpen}
                closeOnPick={!laptop}
                onClose={() => setEmojiOpen(false)}
                onPick={(emoji) => insert(emoji)}
              />
            </Suspense>
          ) : null}
          {linkLoaded ? (
            <Suspense fallback={null}>
              <AddLinkSheet
                open={link !== null}
                initialText={link?.text ?? ''}
                onCancel={() => setLink(null)}
                onSave={(markup) => {
                  const el = field();
                  const at = link;
                  setLink(null);
                  if (el === null || at === null) return;
                  restoreSelection(el, at.start, at.end);
                  insertText(el, markup);
                }}
              />
            </Suspense>
          ) : null}
        </div>
      </div>
    </WritingTrayContext.Provider>
  );
  return (
    <>
      <div ref={slotRef} data-writing-slot="" className="contents" />
      {host !== null && inBrowser ? createPortal(content, host) : content}
    </>
  );
}

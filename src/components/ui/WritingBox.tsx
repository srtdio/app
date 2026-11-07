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
// The card's bottom row: + , Aa, emoji, @ ... send. Aa swaps the row for the
// format row: X (Close formatting), Bold, Italic, Underline, Strike, Link,
// Numbered list, Bullet list, Quote ... send. A button is "on" (panel-3 fill)
// while the caret or selection sits inside that style.
//
// Expand (every mode): a quiet IconExpand top-right while focused or holding
// text. Phone: the same box becomes a full-screen editor (the field never
// remounts, so the text, caret, reply bars and attachments stay); laptop: the
// box grows in place. IconCollapse or Esc returns it; Send closes it.
//
// Speed: pure render at mount. The emoji sheet and Add link sheet load on the
// first tap (React.lazy); the keyboard inset is read only while expanded on a
// phone; selectionchange is listened to only while the format row is open.

import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from 'react';
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
import { useKeyboardInset } from '@/lib/use-keyboard-inset';

const EmojiSheet = lazy(() => import('@/components/ui/EmojiSheet'));
const AddLinkSheet = lazy(() => import('@/components/ui/AddLinkSheet'));

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

/** Keep the field focused (and the keyboard up) when a row key is pressed. */
function keepFocus(e: PointerEvent | MouseEvent): void {
  e.preventDefault();
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
          solid ? 'bg-accent text-accent-fg' : on ? 'bg-panel-3 text-fg' : 'text-fg-2 lit-hover',
        )}
      >
        {children}
      </span>
    </button>
  );
}

/**
 * The card's send: a 36 circle (44 tall hit), grey while there is nothing to
 * send, solid ink when sendable; busy keeps its place with the turning arc.
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
          disabled && !busy ? 'bg-panel-3 text-fg-3' : 'bg-accent text-accent-fg',
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

// The field inside the box drops its own look: the box draws the line, the
// fill and the focus line. Tokens only.
const BOX_OWNS_FIELD =
  '[&_textarea]:border-0 [&_textarea]:bg-transparent [&_textarea]:px-0 [&_textarea]:[--lit-well:none] [&_textarea]:[--sel-edge:transparent]';

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
  /** "@": types "@" at the caret (the field opens its own mention list). */
  mention?: boolean;
  /** Insert text where the caret was (MentionInput keeps its own caret). */
  onInsert?: (text: string) => void;
  /** The expanded editor's title (chat: name and role line; fields: the label). */
  expandTitle?: ReactNode;
  /** Bars above the box (reply, About, edit, private reply), unchanged. */
  strip?: ReactNode;
  /** Chat recording / sending (the recording row is ComposerFrame's, unchanged). */
  state?: ComposerState;
  discard?: ReactNode;
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
    mention = false,
    onInsert,
    expandTitle,
    strip,
    state = { kind: 'idle' },
    discard,
    className,
    invalid = false,
  } = props;
  const isLaptopHook = useIsLaptop();
  const laptop = props.laptop ?? isLaptopHook;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [focused, setFocused] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);
  const [on, setOn] = useState<ReadonlySet<FormatAction>>(() => new Set());
  const [expanded, setExpanded] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiLoaded, setEmojiLoaded] = useState(false);
  const [link, setLink] = useState<{ text: string; start: number; end: number } | null>(null);
  const [linkLoaded, setLinkLoaded] = useState(false);
  const formatting = mode !== 'caption';
  const phoneExpanded = expanded && !laptop;
  const inset = useKeyboardInset(phoneExpanded);

  const refreshOn = useCallback((): void => {
    const el = field();
    if (el === null) return;
    setOn(activeActions(el));
  }, [field]);

  // While the format row is open, follow the caret (contentEditable has no
  // select event of its own). Only then: nothing is listened to at mount.
  useEffect(() => {
    if (!formatOpen) return undefined;
    const onChange = (): void => refreshOn();
    document.addEventListener('selectionchange', onChange);
    refreshOn();
    return () => document.removeEventListener('selectionchange', onChange);
  }, [formatOpen, refreshOn]);

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

  // Send closes the format row and the expanded editor (Slack keeps neither).
  const onSendCapture = (): void => {
    setFormatOpen(false);
    if (expanded) setExpanded(false);
  };

  if (state.kind === 'recording') {
    // Recording keeps today's row exactly (dot, "Recording", m:ss, bin, stop).
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
      : expanded || formatOpen || focused || hasText || state.kind !== 'idle'
        ? 'card'
        : mode === 'chat' && !laptop
          ? 'pill'
          : mode === 'chat'
            ? 'card'
            : 'line';
  const rowShown =
    shape === 'card' || (shape === 'field' && (focused || expanded || emojiOpen || link !== null));
  const showExpand = shape !== 'pill' && (focused || hasText || expanded);

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

  const formatRow = (
    <div
      data-format-row=""
      role="toolbar"
      aria-label="Format"
      className="flex min-w-0 flex-1 items-center overflow-x-auto"
    >
      {shape === 'card' ? (
        <RowKey label="Close formatting" solid onPress={() => setFormatOpen(false)}>
          <IconX size={ICON_SIZE.inline} />
        </RowKey>
      ) : null}
      {FORMAT_KEYS.map((k) => (
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
        <RowKey label="Aa" data-row-key="aa" onPress={() => setFormatOpen(true)}>
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

  const row = rowShown ? (
    <div data-writing-row="" className="flex min-h-11 min-w-0 items-center gap-2">
      {shape === 'field' ? fieldRow : formatOpen ? formatRow : actionRow}
      {shape === 'card' && send !== undefined ? (
        <span className="flex shrink-0" onClickCapture={onSendCapture}>
          {send}
        </span>
      ) : null}
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

  const frameClass = cn(
    'flex min-w-0 border bg-panel-2',
    BOX_OWNS_FIELD,
    shape === 'pill' && 'min-h-11 items-center gap-2 rounded-full pl-1 pr-1',
    shape === 'line' && 'min-h-11 items-end gap-2 rounded-2xl pl-3 pr-1',
    shape === 'card' && 'flex-col rounded-2xl px-3 pt-1 focus-within:lit-focus',
    shape === 'field' &&
      cn(
        'lit-well flex-col rounded-lg px-3 focus-within:lit-focus',
        invalid ? 'border-bad lit-bad' : 'border-field',
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
        const el = field();
        if (el !== null && (e.target === el || el.contains(e.target))) setFocused(true);
      }}
      onBlur={(e) => {
        const next = e.relatedTarget;
        if (next instanceof Node && e.currentTarget.contains(next)) return;
        setFocused(false);
      }}
      onKeyUp={formatOpen ? refreshOn : undefined}
      onMouseUp={formatOpen ? refreshOn : undefined}
    >
      {shape === 'pill' ? leading : null}
      <div
        data-writing-field=""
        className={cn('flex min-w-0 flex-1 items-start', phoneExpanded && 'min-h-0')}
      >
        <div className={cn('min-w-0 flex-1 self-center', phoneExpanded && 'h-full self-stretch')}>
          {input}
        </div>
        {expandKey}
      </div>
      {shape === 'pill' ? pillEnd : null}
      {shape === 'line' && send !== undefined ? (
        <span className="flex shrink-0" onClickCapture={onSendCapture}>
          {send}
        </span>
      ) : null}
      {row}
    </div>
  );

  return (
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
        'flex min-w-0 flex-col gap-2',
        phoneExpanded && 'fixed inset-x-0 top-0 z-sheet bg-panel px-3 pb-2 lit-overlay',
        className,
      )}
      style={phoneExpanded ? { bottom: inset } : undefined}
    >
      {phoneExpanded ? (
        <div data-expanded-bar="" className="wb-safe-top flex min-h-11 items-center gap-2">
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
  );
}

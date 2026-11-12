import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type {
  ChangeEvent,
  ClipboardEvent,
  CSSProperties,
  KeyboardEvent,
  ReactNode,
  TextareaHTMLAttributes,
} from 'react';
import { linePrefix, type FormatRun, type FormatStyle } from '@srtdio/comments';
import { useFormatKeys } from '@/components/ui/format-actions';
import { cn } from '@/lib/cn';
import { FIELD_DISABLED } from '@/components/ui/Input';
import {
  decodeMarkers,
  deleteBesideHidden,
  encodeMarkers,
  historyKind,
  historyPush,
  historyStart,
  historyStep,
  isHiddenMarker,
  liveEdit,
  liveSegments,
  normalizeLive,
  registerLiveField,
  stepOverHidden,
  togglePendingStyle,
  type LiveHistory,
  type LiveSegment,
  type LiveText,
} from '@/lib/format-live';

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /**
   * Opt-in: grow vertically to fit the full content with no inner scrollbar.
   * Height is set imperatively (auto, then scrollHeight) on open, on every value
   * change, and on window resize; sizing lives in inline style so it wins over
   * the base classes regardless of class order (cn() is a plain string join).
   */
  autoGrow?: boolean;
  /**
   * Opt-in single-line composer mode: 44px tall at rest, grows with the content
   * up to 128px, then scrolls. Implies autoGrow without its 96px floor.
   */
  compact?: boolean;
  /**
   * Opt-in WYSIWYG formatting (default off): *bold* _italic_ ~strike~
   * +underline+ ```mono``` show styled while typing and their markers never
   * show (src/lib/format-live.ts: paired markers are held as invisible,
   * zero-width code points of the same length), list and quote lines, and the
   * Cmd/Ctrl shortcuts (the buttons live in ui/WritingBox's Aa row). The value
   * in and out (props.value, onChange, el.value) is the saved marker text,
   * unchanged. Off, the box renders and behaves exactly as before.
   */
  formatting?: boolean;
  /**
   * With formatting: Return in a "1. " / "- " / "> " line continues it (an
   * empty item ends it). Default true; the chat composer owns its Enter
   * (send on a laptop) and continues lists itself, so it passes false.
   */
  listEnter?: boolean;
}

// Layout classes the caller meant for the box's slot in its parent; with
// formatting on they move to the wrapper that holds the box and its mirror.
const LAYOUT_CLASS =
  /^(?:[a-z]+:)*(?:flex-|grow|shrink|basis-|self-|order-|col-|row-|min-w-|max-w-|w-|m[trblxy]?-|-m[trblxy]?-)/;

/** Split a class string into wrapper (layout) and box classes. Pure. */
export function splitLayoutClasses(className: string | undefined): {
  wrapper: string;
  box: string;
} {
  const wrapper: string[] = [];
  const box: string[] = [];
  for (const c of (className ?? '').split(/\s+/)) {
    if (c === '') continue;
    (LAYOUT_CLASS.test(c) ? wrapper : box).push(c);
  }
  return { wrapper: wrapper.join(' '), box: box.join(' ') };
}

// Computed styles the mirror copies so every glyph lands where the
// textarea draws it (the caret must stay exactly aligned).
const MIRROR_PROPS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariant',
  'fontFeatureSettings',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'textIndent',
  'tabSize',
  'wordSpacing',
  'whiteSpace',
  'wordBreak',
  'overflowWrap',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'textAlign',
] as const;

/**
 * The live look of a set of styles (the textarea's mirror and MentionInput's
 * spans). Width neutral, so the mirror's glyphs sit exactly where the
 * textarea draws its caret: bold is a hairline stroke, italic the synthetic
 * slant of the upright face (the app loads no italic face, so advances stay
 * the same), mono a faint token fill in the same font. Pure.
 */
export function liveStyleClass(styles: readonly FormatStyle[]): string {
  return cn(
    styles.includes('bold') && '[-webkit-text-stroke:0.035em_currentColor]',
    styles.includes('italic') && 'italic',
    styles.includes('mono') && 'rounded-sm bg-fg/10',
    styles.includes('strike') && styles.includes('underline')
      ? '[text-decoration-line:underline_line-through]'
      : styles.includes('strike')
        ? 'line-through'
        : styles.includes('underline') && 'underline',
  );
}

/** Mirror classes per run: a marker run draws nothing of its own. Pure. */
export function mirrorClass(run: Pick<FormatRun, 'kind' | 'styles'>): string {
  return run.kind === 'marker' ? '' : liveStyleClass(run.styles);
}

function segmentNodes(segs: readonly LiveSegment[], base: number): ReactNode[] {
  let at = base;
  return segs.map((seg) => {
    const start = at;
    at += seg.text.length;
    return seg.marker || seg.styles.length === 0 ? (
      seg.text
    ) : (
      <span key={start} className={liveStyleClass(seg.styles)}>
        {seg.text}
      </span>
    );
  });
}

/**
 * The mirror's children for a saved value. Pure. The text is drawn as the
 * box holds it (paired markers hidden, zero width), so every glyph and line
 * break matches the textarea. A quote line ("> ") draws its text fg-2 with a
 * 3px fg-3 bar painted over its own prefix (fmt-quote-live in src/index.css),
 * so nothing moves.
 */
export function mirrorNodes(value: string): ReactNode[] {
  const held = encodeMarkers(decodeMarkers(value));
  const nodes: ReactNode[] = [];
  let at = 0;
  held.split('\n').forEach((line, idx) => {
    if (idx > 0) {
      nodes.push('\n');
      at += 1;
    }
    const p = linePrefix(decodeMarkers(line));
    if (p !== null && p.kind === 'quote') {
      nodes.push(
        <span key={`q${at}`} className="fmt-quote-live" data-quote-line="">
          <span className="fmt-quote-mark">{line.slice(0, p.len)}</span>
          {segmentNodes(liveSegments(line.slice(p.len)), at + p.len)}
        </span>,
      );
    } else {
      nodes.push(...segmentNodes(liveSegments(line), at));
    }
    at += line.length;
  });
  // A trailing newline needs a glyph after it to take its line.
  nodes.push('\u200b');
  return nodes;
}

/** The textarea's own value accessors, under the live (saved text) one. */
interface RawValue {
  get: () => string;
  set: (text: string) => void;
}

/**
 * Make `el.value` read and write the saved marker text while the box holds
 * hidden markers (React, the caller, tests and the format actions all see
 * saved text; offsets are identical). Wraps whatever accessor is there
 * (React's value tracker), so React's own bookkeeping still runs. Returns the
 * raw accessors, or null where the engine has none.
 */
function installLiveValue(el: HTMLTextAreaElement): RawValue | null {
  const own = Object.getOwnPropertyDescriptor(el, 'value');
  const base = own ?? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  const getter = base?.get;
  const setter = base?.set;
  if (getter === undefined || setter === undefined) return null;
  const raw: RawValue = {
    get: () => String(getter.call(el)),
    set: (text: string) => setter.call(el, text),
  };
  Object.defineProperty(el, 'value', {
    configurable: true,
    enumerable: true,
    get: () => decodeMarkers(raw.get()),
    set: (v: unknown) => raw.set(encodeMarkers(decodeMarkers(String(v ?? '')))),
  });
  const now = raw.get();
  const held = encodeMarkers(decodeMarkers(now));
  if (held !== now) raw.set(held);
  return raw;
}

/** Forwards its ref to the textarea (the chat composer focuses it); no visual change. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    className,
    autoGrow: autoGrowProp = false,
    compact = false,
    formatting = false,
    listEnter = true,
    style,
    value,
    onChange,
    onSelect,
    onBlur,
    onKeyDown,
    onScroll,
    onCopy,
    onCut,
    onCompositionStart,
    onCompositionEnd,
    ...props
  },
  forwardedRef,
) {
  const autoGrow = autoGrowProp || compact;
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // The live mirror needs the text: a controlled string value.
  const live = formatting && typeof value === 'string';
  const liveOn = useRef(live);
  liveOn.current = live;
  // Live editing state: the raw accessors, the text before the edit in
  // flight, composition, pending styles (a format key with no selection),
  // the box's own undo. All refs: nothing here renders.
  const rawRef = useRef<RawValue | null>(null);
  const prevRaw = useRef<string | null>(null);
  const composing = useRef(false);
  const pending = useRef<{ styles: FormatStyle[]; at: number }>({ styles: [], at: -1 });
  const history = useRef<LiveHistory | null>(null);
  const pendingKind = useRef('edit');
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const setRef = useCallback(
    (el: HTMLTextAreaElement | null): void => {
      ref.current = el;
      if (el !== null && liveOn.current && rawRef.current === null) {
        rawRef.current = installLiveValue(el);
        const held = rawRef.current?.get() ?? '';
        prevRaw.current = held;
        history.current = historyStart({ text: held, start: held.length, end: held.length });
      }
      if (typeof forwardedRef === 'function') forwardedRef(el);
      else if (forwardedRef !== null) forwardedRef.current = el;
    },
    [forwardedRef],
  );
  const formatKeys = useFormatKeys(ref, formatting, { listEnter });

  /** Tell the caller the value changed (a script edit: no native input event). */
  const notify = useCallback((): void => {
    const el = ref.current;
    const cb = onChangeRef.current;
    if (el === null || cb === undefined) return;
    const event = {
      target: el,
      currentTarget: el,
      type: 'change',
      bubbles: true,
      defaultPrevented: false,
      isTrusted: false,
      nativeEvent: new Event('input'),
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
      isDefaultPrevented: () => false,
      isPropagationStopped: () => false,
      persist: () => undefined,
    };
    cb(event as unknown as ChangeEvent<HTMLTextAreaElement>);
  }, []);

  /** Put a settled text in the box (a script edit), record it, tell the caller. */
  const applyLive = useCallback(
    (next: LiveText, kind: string): void => {
      const el = ref.current;
      const raw = rawRef.current;
      if (el === null || raw === null) return;
      if (raw.get() !== next.text) raw.set(next.text);
      el.setSelectionRange(next.start, next.end);
      prevRaw.current = next.text;
      if (history.current !== null) {
        history.current = historyPush(
          history.current,
          { text: next.text, start: next.start, end: next.end },
          kind,
          Date.now(),
        );
      }
      notify();
    },
    [notify],
  );

  const stepHistory = useCallback(
    (dir: -1 | 1): void => {
      const h = history.current;
      if (h === null) return;
      const step = historyStep(h, dir);
      if (step === null) return;
      history.current = step.history;
      const el = ref.current;
      const raw = rawRef.current;
      if (el === null || raw === null) return;
      raw.set(step.snap.text);
      el.setSelectionRange(step.snap.start, step.snap.end);
      prevRaw.current = step.snap.text;
      notify();
    },
    [notify],
  );

  // Register with the format actions: edits through the same rules, and the
  // styles a format key holds for the next typed text.
  useEffect(() => {
    const el = ref.current;
    if (!live || el === null) return undefined;
    return registerLiveField(el, {
      replace: (from, to, insert, selStart, selEnd) => {
        const raw = rawRef.current;
        if (raw === null) return;
        const held = raw.get();
        el.focus({ preventScroll: true });
        applyLive(
          normalizeLive(held.slice(0, from) + insert + held.slice(to), selStart, selEnd),
          'format',
        );
      },
      pending: () => pending.current.styles,
      togglePending: (style) => {
        el.focus({ preventScroll: true });
        pending.current = {
          styles: togglePendingStyle(pending.current.styles, style),
          at: el.selectionStart,
        };
      },
    });
  }, [live, applyLive]);

  // The text before each edit, and the edits that must never touch a hidden
  // marker on their own (Backspace / Delete beside one), plus Undo / Redo
  // from menus and gestures. Listened to only on a live box.
  useEffect(() => {
    const el = ref.current;
    if (!live || el === null) return undefined;
    const onBeforeInput = (e: Event): void => {
      const raw = rawRef.current;
      if (raw === null) return;
      const ie = e as InputEvent;
      if (!composing.current) prevRaw.current = raw.get();
      pendingKind.current = historyKind(ie.inputType);
      if (ie.isComposing === true) return;
      if (ie.inputType === 'historyUndo' || ie.inputType === 'historyRedo') {
        e.preventDefault();
        stepHistory(ie.inputType === 'historyUndo' ? -1 : 1);
        return;
      }
      if (
        (ie.inputType === 'deleteContentBackward' || ie.inputType === 'deleteContentForward') &&
        el.selectionStart === el.selectionEnd
      ) {
        const held = raw.get();
        const span = deleteBesideHidden(
          held,
          el.selectionStart,
          ie.inputType === 'deleteContentBackward' ? -1 : 1,
        );
        if (span === null) return;
        e.preventDefault();
        applyLive(
          normalizeLive(held.slice(0, span.from) + held.slice(span.to), span.from, span.from),
          'delete',
        );
      }
    };
    el.addEventListener('beforeinput', onBeforeInput);
    return () => el.removeEventListener('beforeinput', onBeforeInput);
  }, [live, applyLive, stepHistory]);

  /** Settle the edit the browser just made (pairs hide, broken ones go). */
  const settle = useCallback((el: HTMLTextAreaElement, kind: string): void => {
    const raw = rawRef.current;
    if (raw === null) return;
    const now = raw.get();
    const before = prevRaw.current ?? now;
    const styles = pending.current.styles;
    const r = liveEdit(before, now, { start: el.selectionStart, end: el.selectionEnd }, styles);
    if (r.usedPending) pending.current = { styles: [], at: -1 };
    // Styles still held (typed a space first): they wait at the new caret.
    else if (styles.length > 0) pending.current = { styles, at: r.start };
    if (r.text !== now) {
      raw.set(r.text);
      el.setSelectionRange(r.start, r.end);
    }
    prevRaw.current = r.text;
    if (history.current !== null) {
      history.current = historyPush(
        history.current,
        { text: r.text, start: r.start, end: r.end },
        kind,
        Date.now(),
      );
    }
  }, []);

  // A value set from outside (a send clears it, a mention pick, an emoji):
  // the box already holds it (el.value encodes); it becomes the base for the
  // next edit and an undo step.
  useLayoutEffect(() => {
    const raw = rawRef.current;
    if (!live || raw === null) return;
    const held = raw.get();
    if (prevRaw.current === held) return;
    prevRaw.current = held;
    if (history.current !== null) {
      const el = ref.current;
      const at = el?.selectionEnd ?? held.length;
      history.current = historyPush(
        history.current,
        { text: held, start: at, end: at },
        'external',
        Date.now(),
      );
    }
  }, [live, value]);

  // Measure at 'auto', then set the content height. The 'auto' instant makes
  // a long text's page shorter, so the window and any scrolled ancestor would
  // be clamped: their scroll is held across the measure and put back in the
  // same call (before paint). An unchanged height writes nothing new.
  const fit = useCallback((): void => {
    const el = ref.current;
    if (el === null) return;
    const held: { node: Element; top: number }[] = [];
    for (let at = el.parentElement; at !== null; at = at.parentElement) {
      if (at.scrollTop > 0) held.push({ node: at, top: at.scrollTop });
    }
    const sx = window.scrollX;
    const sy = window.scrollY;
    const before = el.style.height;
    el.style.height = 'auto';
    const next = `${el.scrollHeight}px`;
    el.style.height = next === before ? before : next;
    for (const h of held) if (h.node.scrollTop !== h.top) h.node.scrollTop = h.top;
    if (window.scrollX !== sx || window.scrollY !== sy) window.scrollTo(sx, sy);
  }, []);

  // On open and on every value change (controlled input): re-fit synchronously
  // before paint so the height never flashes at the wrong size.
  useLayoutEffect(() => {
    if (!autoGrow) return;
    fit();
  }, [autoGrow, fit, value]);

  // Mirror geometry follows the box on every value change (after the fit
  // above): box, size and scroll. Reads only, from the layout just done.
  const placeMirror = useCallback((): void => {
    const el = ref.current;
    const m = mirrorRef.current;
    if (el === null || m === null) return;
    m.style.left = `${el.offsetLeft + el.clientLeft}px`;
    m.style.top = `${el.offsetTop + el.clientTop}px`;
    m.style.width = `${el.clientWidth}px`;
    m.style.height = `${el.clientHeight}px`;
    m.scrollTop = el.scrollTop;
  }, []);

  // The wrapper takes the box's slot, so the box keeps the display it had
  // there: blockified as a flex or grid item (composer rows), inline-block in
  // a block parent (form fields keep their line gap). Set before paint, once.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const el = ref.current;
    if (!formatting || wrap === null || el === null || wrap.parentElement === null) return;
    const display = window.getComputedStyle(wrap.parentElement).display;
    if (/flex|grid/.test(display)) el.style.display = 'block';
  }, [formatting]);

  // Copy the type styles once per look (class / mode change), not per key.
  useLayoutEffect(() => {
    if (!live) return;
    const el = ref.current;
    const m = mirrorRef.current;
    if (el === null || m === null) return;
    const cs = window.getComputedStyle(el);
    for (const p of MIRROR_PROPS) m.style[p] = cs[p];
    placeMirror();
  }, [live, className, compact, autoGrow, placeMirror]);

  useLayoutEffect(() => {
    if (live) placeMirror();
  }, [live, value, placeMirror]);

  // Wrapping depends on width, so re-fit when the viewport resizes.
  useEffect(() => {
    if (!autoGrow && !live) return undefined;
    const onResize = (): void => {
      if (autoGrow) fit();
      if (live) placeMirror();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [autoGrow, live, fit, placeMirror]);

  const nodes = useMemo(
    () => (formatting && typeof value === 'string' ? mirrorNodes(value) : null),
    [formatting, value],
  );

  /** Live keys: Undo / Redo (the box's own), arrows stepping over hidden markers. */
  const liveKeys = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const el = e.currentTarget;
    const raw = rawRef.current;
    if (raw === null || e.nativeEvent.isComposing) return false;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && (key === 'z' || (key === 'y' && e.ctrlKey && !e.metaKey))) {
      e.preventDefault();
      stepHistory(key === 'y' || e.shiftKey ? 1 : -1);
      return true;
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !mod && !e.altKey) {
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      if (!e.shiftKey && start !== end) return false;
      const backward = el.selectionDirection === 'backward';
      const focus = e.shiftKey ? (backward ? start : end) : start;
      const anchor = e.shiftKey ? (backward ? end : start) : start;
      const held = raw.get();
      if (!isHiddenMarker(dir < 0 ? held[focus - 1] : held[focus])) return false;
      e.preventDefault();
      const next = stepOverHidden(held, focus, dir);
      if (!e.shiftKey) el.setSelectionRange(next, next);
      else if (next < anchor) el.setSelectionRange(next, anchor, 'backward');
      else el.setSelectionRange(anchor, next, 'forward');
      return true;
    }
    return false;
  };

  /** Copy / cut carry the saved text (the markers), never the hidden code points. */
  const liveClipboard = (e: ClipboardEvent<HTMLTextAreaElement>, cut: boolean): void => {
    const el = e.currentTarget;
    const raw = rawRef.current;
    if (raw === null) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (start === end) return;
    const held = raw.get();
    e.preventDefault();
    e.clipboardData.setData('text/plain', decodeMarkers(held.slice(start, end)));
    if (cut) applyLive(normalizeLive(held.slice(0, start) + held.slice(end), start, start), 'cut');
  };

  // 16px font-size avoids iOS zoom-on-focus; overflow/resize off means no inner
  // scrollbar and no user drag-resize. No transition: the height change is
  // instant. Colours stay token-driven, so light/dark parity is unaffected.
  const autoGrowStyle: CSSProperties = compact
    ? { resize: 'none', overflowY: 'auto', fontSize: '16px', lineHeight: 1.4 }
    : autoGrow
      ? {
          resize: 'none',
          overflowY: 'hidden',
          minHeight: '96px',
          fontSize: '16px',
          lineHeight: 1.55,
        }
      : {};

  const split = formatting ? splitLayoutClasses(className) : null;
  const box = (
    <textarea
      ref={setRef}
      value={value}
      data-live-format={live ? '' : undefined}
      className={cn(
        // 16px text below md so iOS Safari does not zoom on focus; 14px from md up.
        'lit-well w-full px-3 rounded-lg border border-field bg-panel-2 text-fg text-input md:text-base placeholder:text-fg-3 outline-none focus:lit-focus h-auto',
        FIELD_DISABLED,
        // Compact (every reply box, 12 Nov 2026): a block (no inline line gap
        // under it) whose one 20 line sits on the 44 box's vertical centre
        // (12 + 20 + 12), level with the "+" beside it. Others keep field-y.
        compact ? 'block min-h-11 max-h-32 py-3' : 'min-h-18 py-field-y',
        split !== null ? split.box : className,
        // Live styling: the mirror draws the glyphs; the box keeps the caret
        // (fg), the selection and the placeholder.
        live &&
          'caret-fg [-webkit-text-fill-color:transparent] placeholder:[-webkit-text-fill-color:currentColor]',
      )}
      style={{ ...autoGrowStyle, ...style }}
      onChange={(e) => {
        if (live && !composing.current) settle(e.currentTarget, pendingKind.current);
        pendingKind.current = 'edit';
        onChange?.(e);
      }}
      onSelect={(e) => {
        // A caret moved away from where a format key was pressed drops it.
        const p = pending.current;
        if (p.styles.length > 0 && e.currentTarget.selectionStart !== p.at) {
          pending.current = { styles: [], at: -1 };
        }
        onSelect?.(e);
      }}
      onBlur={onBlur}
      onCompositionStart={(e) => {
        if (live) {
          composing.current = true;
          prevRaw.current = rawRef.current?.get() ?? prevRaw.current;
        }
        onCompositionStart?.(e);
      }}
      onCompositionEnd={(e) => {
        if (live) {
          composing.current = false;
          settle(e.currentTarget, 'type');
          notify();
        }
        onCompositionEnd?.(e);
      }}
      onCopy={(e) => {
        onCopy?.(e);
        if (live && !e.defaultPrevented) liveClipboard(e, false);
      }}
      onCut={(e) => {
        onCut?.(e);
        if (live && !e.defaultPrevented) liveClipboard(e, true);
      }}
      onKeyDown={(e) => {
        if (live && liveKeys(e)) return;
        if (formatKeys(e)) return;
        onKeyDown?.(e);
      }}
      onScroll={(e) => {
        if (live && mirrorRef.current !== null) {
          mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
        }
        onScroll?.(e);
      }}
      {...props}
    />
  );

  if (split === null) return box;
  return (
    // The wrapper takes the box's slot: full width like the box was, unless
    // the caller gave its own width.
    <div
      ref={wrapRef}
      className={cn(
        'relative',
        !/(^|\s)(?:[a-z]+:)*w-/.test(split.wrapper) && 'w-full',
        split.wrapper,
      )}
    >
      {box}
      {live ? (
        <div
          ref={mirrorRef}
          aria-hidden="true"
          data-format-mirror=""
          // Ink is the token (fg; fg-3 disabled), so a theme switch repaints it.
          className={cn(
            'pointer-events-none absolute overflow-hidden',
            props.disabled === true ? 'text-fg-3' : 'text-fg',
          )}
        >
          {nodes}
        </div>
      ) : null}
    </div>
  );
});

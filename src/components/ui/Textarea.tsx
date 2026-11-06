import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { CSSProperties, ReactNode, TextareaHTMLAttributes } from 'react';
import { parseFormatRuns, type FormatRun } from '@srtdio/comments';
import { useFormatStrip } from '@/components/ui/FormatStrip';
import { cn } from '@/lib/cn';

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
   * Opt-in WhatsApp-style formatting (default off): live styling of
   * *bold* _italic_ ~strike~ +underline+ ```mono``` while typing (markers stay
   * visible, faded), the format strip on a selection, and the Cmd/Ctrl
   * shortcuts. Off, the box renders and behaves exactly as before.
   */
  formatting?: boolean;
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

/** Mirror classes per style. Width neutral: bold is a hairline stroke, italic
 *  shows its faded markers only (a slant would move glyphs), mono keeps the
 *  same font on a faint token fill. Markers are faded fg-3. */
export function mirrorClass(run: FormatRun): string {
  return cn(
    run.kind === 'marker' && 'text-fg-3',
    run.kind === 'text' &&
      run.styles.includes('bold') &&
      '[-webkit-text-stroke:0.03em_currentColor]',
    run.kind === 'text' && run.styles.includes('mono') && 'rounded-sm bg-fg/10',
    run.styles.includes('strike') && run.styles.includes('underline')
      ? '[text-decoration-line:underline_line-through]'
      : run.styles.includes('strike')
        ? 'line-through'
        : run.styles.includes('underline') && 'underline',
  );
}

/** The mirror's children for a value. Pure. */
export function mirrorNodes(value: string): ReactNode[] {
  // Each run is keyed by its character offset in the value (stable per value).
  let at = 0;
  const nodes: ReactNode[] = parseFormatRuns(value).map((run) => {
    const start = at;
    at += run.text.length;
    return run.kind === 'text' && run.styles.length === 0 ? (
      run.text
    ) : (
      <span key={start} className={mirrorClass(run)}>
        {run.text}
      </span>
    );
  });
  // A trailing newline needs a glyph after it to take its line.
  nodes.push('\u200b');
  return nodes;
}

/** Forwards its ref to the textarea (the chat composer focuses it); no visual change. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    className,
    autoGrow: autoGrowProp = false,
    compact = false,
    formatting = false,
    style,
    value,
    onSelect,
    onBlur,
    onKeyDown,
    onScroll,
    ...props
  },
  forwardedRef,
) {
  const autoGrow = autoGrowProp || compact;
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null): void => {
      ref.current = el;
      if (typeof forwardedRef === 'function') forwardedRef(el);
      else if (forwardedRef !== null) forwardedRef.current = el;
    },
    [forwardedRef],
  );
  const fmt = useFormatStrip(ref, formatting);
  // The live mirror needs the text: a controlled string value.
  const live = formatting && typeof value === 'string';

  const fit = useCallback((): void => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
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
      className={cn(
        // 16px text below md so iOS Safari does not zoom on focus; 14px from md up.
        'lit-well w-full px-3 rounded-lg border border-field bg-panel-2 text-fg text-input md:text-base placeholder:text-fg-3 outline-none focus:lit-focus disabled:text-fg-3 py-2.5 h-auto',
        compact ? 'min-h-11 max-h-32' : 'min-h-18',
        split !== null ? split.box : className,
        // Live styling: the mirror draws the glyphs; the box keeps the caret
        // (fg), the selection and the placeholder.
        live &&
          'caret-fg [-webkit-text-fill-color:transparent] placeholder:[-webkit-text-fill-color:currentColor]',
      )}
      style={{ ...autoGrowStyle, ...style }}
      onSelect={(e) => {
        fmt.onSelect(e);
        onSelect?.(e);
      }}
      onBlur={(e) => {
        fmt.onBlur();
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (fmt.onKeyDown(e)) return;
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
      {fmt.strip}
    </div>
  );
});

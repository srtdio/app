import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { CSSProperties, TextareaHTMLAttributes } from 'react';
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
   * up to 120px, then scrolls. Implies autoGrow without its 96px floor.
   */
  compact?: boolean;
}

/** Forwards its ref to the textarea (the chat composer focuses it); no visual change. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, autoGrow: autoGrowProp = false, compact = false, style, value, ...props },
  forwardedRef,
) {
  const autoGrow = autoGrowProp || compact;
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const setRef = useCallback(
    (el: HTMLTextAreaElement | null): void => {
      ref.current = el;
      if (typeof forwardedRef === 'function') forwardedRef(el);
      else if (forwardedRef !== null) forwardedRef.current = el;
    },
    [forwardedRef],
  );

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

  // Wrapping depends on width, so re-fit when the viewport resizes.
  useEffect(() => {
    if (!autoGrow) return undefined;
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [autoGrow, fit]);

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

  return (
    <textarea
      ref={setRef}
      value={value}
      className={cn(
        // 16px text below md so iOS Safari does not zoom on focus; 14px from md up.
        'w-full px-3 rounded-md border border-border bg-panel-2 text-fg text-base md:text-sm placeholder:text-fg-3 outline-none focus:border-accent-line focus:ring-2 focus:ring-accent-soft py-2.5 h-auto',
        compact ? 'min-h-[44px] max-h-[120px]' : 'min-h-[74px]',
        className,
      )}
      style={{ ...autoGrowStyle, ...style }}
      {...props}
    />
  );
});

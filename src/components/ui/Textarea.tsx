import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
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
}

export function Textarea({
  className,
  autoGrow = false,
  style,
  value,
  ...props
}: TextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

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
  const autoGrowStyle: CSSProperties = autoGrow
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
      ref={ref}
      value={value}
      className={cn(
        'w-full px-3 rounded-md border border-border bg-panel-2 text-fg text-sm placeholder:text-fg-3 outline-none focus:border-accent-line focus:ring-2 focus:ring-accent-soft min-h-[74px] py-2.5 h-auto',
        className,
      )}
      style={{ ...autoGrowStyle, ...style }}
      {...props}
    />
  );
}

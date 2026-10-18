import type { CSSProperties } from 'react';
import { IconCheck, IconX } from '@/components/ui/icons';
import type { Toast as ToastModel } from '@/components/ui/toast/types';

interface ToastProps {
  toast: ToastModel;
  /** True while the card plays its exit before the provider unmounts it. */
  leaving?: boolean;
  /** The X: the provider treats it as accept (onExpire runs). */
  onDismiss: (id: string) => void;
  /** The action button. Omitted: runs action.onPress, then onDismiss. */
  onAction?: (id: string) => void;
}

/**
 * One presentational toast card. Hookless so it can be unit-tested by walking
 * its element tree (the codebase convention for pure components). The whole
 * content area is the press target when `onPress` is set; the dismiss control
 * is always a separate 44x44 button so the two never nest. An optional action
 * (e.g. Undo) is its own 44px button at the card's right end, after the dismiss; pressing it runs the
 * action and dismisses the toast. With a countdown, a 3px bar along the bottom
 * edge empties over the toast's duration. Enter glides up and
 * fades in (--dur-slow); exit fades down (--dur-base); axis is translateY only.
 */
export function Toast({ toast, leaving = false, onDismiss, onAction }: ToastProps) {
  const { id, title, description, icon, onPress, action, tone, countdownMs } = toast;
  const success = tone === 'success';

  // Motion via keyframes (defined once in the viewport) so the card stays
  // hookless. Durations/easings read from the motion tokens, never hardcoded.
  const animation = leaving
    ? 'sorted-toast-out var(--dur-base) var(--ease-exit) forwards'
    : 'sorted-toast-in var(--dur-slow) var(--ease-enter)';

  const body = (
    <>
      {icon !== undefined ? (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center text-fg-2">{icon}</span>
      ) : success ? (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center text-good">
          <IconCheck size={16} />
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-fg">{title}</span>
        {description !== undefined ? (
          <span className="truncate text-xs text-fg-2">{description}</span>
        ) : null}
      </span>
    </>
  );

  return (
    <div
      style={{ animation }}
      {...(success ? { 'data-toast-tone': 'success' } : {})}
      className={`pointer-events-auto ${countdownMs !== undefined ? 'relative ' : ''}flex w-full max-w-sm items-center gap-2 rounded-lg border pr-1 shadow-lg ${
        success
          ? 'border-good bg-panel [background-image:linear-gradient(var(--good-soft),var(--good-soft))]'
          : 'border-border bg-panel'
      }`}
    >
      {onPress !== undefined ? (
        <button
          type="button"
          onClick={onPress}
          className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 rounded-l-lg px-3 py-2 text-left transition-colors hover:bg-panel-2"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 px-3 py-2">{body}</div>
      )}
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(id)}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg"
      >
        <IconX />
      </button>
      {action !== undefined ? (
        <button
          type="button"
          data-toast-action=""
          onClick={() => {
            if (onAction !== undefined) {
              onAction(id);
              return;
            }
            action.onPress();
            onDismiss(id);
          }}
          className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md px-3 text-sm font-semibold text-accent transition-colors hover:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {action.label}
        </button>
      ) : null}
      {countdownMs !== undefined ? (
        // Track = border token, fill = accent token; the fill empties linearly
        // over the toast's duration. Reduced motion: no animation, a static bar
        // (the timer still runs).
        <span
          data-toast-countdown=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px] overflow-hidden rounded-b-lg bg-border"
        >
          <span
            style={{ '--toast-countdown-ms': `${countdownMs}ms` } as CSSProperties}
            className="block h-full w-full bg-accent motion-safe:[animation:sorted-toast-countdown_var(--toast-countdown-ms)_linear_forwards]"
          />
        </span>
      ) : null}
    </div>
  );
}

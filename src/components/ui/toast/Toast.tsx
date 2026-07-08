import { IconX } from '@/components/ui/icons';
import type { Toast as ToastModel } from '@/components/ui/toast/types';

interface ToastProps {
  toast: ToastModel;
  /** True while the card plays its exit before the provider unmounts it. */
  leaving?: boolean;
  onDismiss: (id: string) => void;
}

/**
 * One presentational toast card. Hookless so it can be unit-tested by walking
 * its element tree (the codebase convention for pure components). The whole
 * content area is the press target when `onPress` is set; the dismiss control
 * is always a separate 44x44 button so the two never nest. Enter glides up and
 * fades in (--dur-slow); exit fades down (--dur-base); axis is translateY only.
 */
export function Toast({ toast, leaving = false, onDismiss }: ToastProps) {
  const { id, title, description, icon, onPress } = toast;

  // Motion via keyframes (defined once in the viewport) so the card stays
  // hookless. Durations/easings read from the motion tokens, never hardcoded.
  const animation = leaving
    ? 'sorted-toast-out var(--dur-base) var(--ease-exit) forwards'
    : 'sorted-toast-in var(--dur-slow) var(--ease-enter)';

  const body = (
    <>
      {icon !== undefined ? (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center text-fg-2">{icon}</span>
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
      className="pointer-events-auto flex w-full max-w-sm items-center gap-2 rounded-lg border border-border bg-panel pr-1 shadow-lg"
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
    </div>
  );
}

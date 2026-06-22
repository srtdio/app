import { IconX } from '@/components/ui/icons';
import type { Toast as ToastModel } from '@/components/ui/toast/types';

interface ToastProps {
  toast: ToastModel;
  onDismiss: (id: string) => void;
}

/**
 * One presentational toast card. Hookless so it can be unit-tested by walking
 * its element tree (the codebase convention for pure components). The whole
 * content area is the press target when `onPress` is set; the dismiss control
 * is always a separate 44x44 button so the two never nest.
 */
export function Toast({ toast, onDismiss }: ToastProps) {
  const { id, title, description, icon, onPress } = toast;

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
      style={{ animation: 'sorted-toast-in 180ms ease-out' }}
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

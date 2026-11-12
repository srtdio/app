import { ClearButton } from '@/components/ui/Button';
import { IconAlertTriangle, IconCheck, ICON_SIZE } from '@/components/ui/icons';
import type { Toast as ToastModel } from '@/components/ui/toast/types';

interface ToastProps {
  toast: ToastModel;
  /** True while the card plays its exit before the provider unmounts it. */
  leaving?: boolean;
  /** The "Clear" button: the provider treats it as accept (onExpire runs). */
  onDismiss: (id: string) => void;
  /** The action button. Omitted: runs action.onPress, then onDismiss. */
  onAction?: (id: string) => void;
}

/**
 * One presentational toast card. Hookless so it can be unit-tested by walking
 * its element tree (the codebase convention for pure components). The whole
 * content area is the press target when `onPress` is set; the dismiss control
 * is always a separate outlined Clear pill (ui/Button ClearButton, 44 tall
 * hit, aria "Dismiss notification"; no X) so the two never nest. Auto-hide and swipe stay. An optional action
 * (e.g. Undo) is its own 44px button at the card's right end, after the dismiss; pressing it runs the
 * action and dismisses the toast. Undo toasts never render here (UndoStrip).
 * It always renders at rest: the viewport lays the edgeStrip move over it
 * (drops from the top, swipe up dismisses, leaves the same way). Never a fade.
 */
export function Toast({ toast, leaving = false, onDismiss, onAction }: ToastProps) {
  const { id, title, description, icon, onPress, action, tone } = toast;
  const success = tone === 'success';
  // A failure (or partial failure) toast: bad-solid fill under accent-fg ink, so it
  // never reads as the success style. accent-fg (white) on bad-solid is 4.5:1 or more in
  // both themes (index.css keeps the light value in dark).
  const error = tone === 'error';

  const body = (
    <>
      {icon !== undefined ? (
        <span
          className={`flex h-6 w-6 shrink-0 items-center justify-center ${error ? 'text-accent-fg' : 'text-fg-2'}`}
        >
          {icon}
        </span>
      ) : error ? (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center text-accent-fg">
          <IconAlertTriangle size={ICON_SIZE.inline} />
        </span>
      ) : success ? (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center text-good">
          <IconCheck size={ICON_SIZE.inline} />
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        {/* Phone: the note wraps (two lines at most) beside Clear, never cut
            short of its words; from 768 it stays one line. */}
        <span
          data-toast-title=""
          className={`truncate text-base font-medium max-md:line-clamp-2 max-md:whitespace-normal max-md:break-words ${error ? 'text-accent-fg' : 'text-fg'}`}
        >
          {title}
        </span>
        {description !== undefined ? (
          <span className={`truncate text-sm ${error ? 'text-accent-fg' : 'text-fg-2'}`}>
            {description}
          </span>
        ) : null}
      </span>
    </>
  );

  return (
    <div
      {...(leaving ? { 'data-leaving': '' } : {})}
      {...(success ? { 'data-toast-tone': 'success' } : {})}
      {...(error ? { 'data-toast-tone': 'error', role: 'alert' } : {})}
      className={`pointer-events-auto flex w-full max-w-sm items-center gap-2 rounded-lg border pr-1 lit-float ${
        error
          ? 'border-bad-solid bg-bad-solid'
          : success
            ? 'border-good bg-panel bg-good-tint'
            : 'border-border bg-panel'
      }`}
    >
      {onPress !== undefined ? (
        <button
          type="button"
          onClick={onPress}
          className={`flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-l-lg px-3 py-2 text-left mv-tint lit-hover focus-visible:lit-focus ${error ? 'focus-visible:outline-accent-fg' : ''}`}
        >
          {body}
        </button>
      ) : (
        <div className="flex min-h-11 min-w-0 flex-1 items-center gap-3 px-3 py-2">{body}</div>
      )}
      <ClearButton
        aria-label="Dismiss notification"
        onClick={() => onDismiss(id)}
        className={error ? 'focus-visible:outline-accent-fg' : undefined}
        faceClassName={error ? 'text-accent-fg' : undefined}
      />
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
          className={`flex h-11 min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg px-4 text-base font-medium mv-tint ${
            error
              ? 'text-accent-fg underline lit-hover focus-visible:lit-focus focus-visible:outline-accent-fg'
              : 'text-accent lit-hover focus-visible:lit-focus'
          }`}
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

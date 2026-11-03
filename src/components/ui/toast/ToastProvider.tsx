import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Toast } from '@/components/ui/toast/Toast';
import { UndoStrip } from '@/components/ui/toast/UndoStrip';
import type { Toast as ToastModel, ToastApi, ToastOptions } from '@/components/ui/toast/types';
import { cn } from '@/lib/cn';
import {
  DUR_SHEET_OUT_MS,
  TOAST_DISMISS_PX,
  riseIn,
  stripIn,
  stripOut,
  useDragDismiss,
  useMotionOff,
} from '@/lib/motion';

/** Default auto-dismiss delay when `durationMs` is omitted. */
export const DEFAULT_DURATION_MS = 4000;
/** Newest-first cap on top cards; older cards beyond this are dropped on show(). */
export const MAX_VISIBLE = 3;
/**
 * Exit length; mirrors the edgeStrip exit (stripOut, --dur-sheet-out). A
 * dismissed toast is marked `leaving` and removed this long afterwards so it
 * can leave the way it came. The timer fires with motion off too (the card is
 * hidden at once then), so unmount always happens.
 */
export const EXIT_MS = DUR_SHEET_OUT_MS;

/** A toast plus its closing-phase flag. Kept local so ToastModel stays minimal. */
interface ManagedToast extends ToastModel {
  /** True once dismiss() starts the exit; the card unmounts after EXIT_MS. */
  leaving: boolean;
}

/**
 * Framework-agnostic toast core. Owns the list and one timer per toast so the
 * provider stays a thin React mirror and the behaviour is unit-testable with
 * fake timers (mirrors createLongPressController). State is in memory only;
 * nothing touches localStorage/sessionStorage.
 */
interface ToastStore extends ToastApi {
  /** End a toast as accepted (its X or timer): onExpire once, then dismiss. */
  expire: (id: string) => void;
  /** Press a toast's action: run it, then dismiss; onExpire never runs. */
  act: (id: string) => void;
  getSnapshot: () => ManagedToast[];
  subscribe: (listener: (toasts: ManagedToast[]) => void) => () => void;
  /** Clear every pending timer and listener. Called on provider unmount. */
  dispose: () => void;
}

export function createToastStore(): ToastStore {
  let toasts: ManagedToast[] = [];
  let seq = 0;
  const listeners = new Set<(toasts: ManagedToast[]) => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // onExpire per live toast; deleted when it fires or the action is pressed, so
  // it runs at most once.
  const expires = new Map<string, () => void>();

  function emit(): void {
    for (const listener of listeners) listener(toasts);
  }

  function clearTimer(id: string): void {
    const handle = timers.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.delete(id);
    }
  }

  function remove(id: string): void {
    clearTimer(id);
    const next = toasts.filter((toast) => toast.id !== id);
    if (next.length !== toasts.length) {
      toasts = next;
      emit();
    }
  }

  // Closing phase: flip the toast to `leaving` so its card plays the exit, then
  // remove it after EXIT_MS. Idempotent; the auto-dismiss timer is replaced by
  // the removal timer under the same id.
  function dismiss(id: string): void {
    const current = toasts.find((toast) => toast.id === id);
    if (current === undefined || current.leaving) return;
    clearTimer(id);
    toasts = toasts.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast));
    emit();
    timers.set(
      id,
      setTimeout(() => remove(id), EXIT_MS),
    );
  }

  // Run a toast's onExpire once, then forget it.
  function runExpire(id: string): void {
    const onExpire = expires.get(id);
    if (onExpire === undefined) return;
    expires.delete(id);
    onExpire();
  }

  // The toast ended without its action (timer or X): accept, then close.
  function expire(id: string): void {
    runExpire(id);
    dismiss(id);
  }

  // The action was pressed: run it, close, and never expire.
  function act(id: string): void {
    const current = toasts.find((toast) => toast.id === id);
    if (current === undefined || current.leaving) return;
    expires.delete(id);
    current.action?.onPress();
    dismiss(id);
  }

  function show(options: ToastOptions): string {
    const id = String((seq += 1));
    const toast: ManagedToast = {
      id,
      title: options.title,
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.icon !== undefined ? { icon: options.icon } : {}),
      ...(options.onPress !== undefined ? { onPress: options.onPress } : {}),
      ...(options.action !== undefined ? { action: options.action } : {}),
      ...(options.tone !== undefined ? { tone: options.tone } : {}),
      ...(options.kind !== undefined ? { kind: options.kind } : {}),
      leaving: false,
    };
    const ms = options.durationMs === undefined ? DEFAULT_DURATION_MS : options.durationMs;
    const timedMs = ms !== null && ms > 0 ? ms : null;
    if (options.onExpire !== undefined) expires.set(id, options.onExpire);

    // One strip at a time: a new Undo strip accepts the live one (commit now)
    // and lets it play its exit. Cards keep their newest-first cap, which never
    // counts the strip.
    if (toast.kind === 'undo') {
      for (const old of toasts) {
        if (old.kind === 'undo' && !old.leaving) {
          runExpire(old.id);
          dismiss(old.id);
        }
      }
      toasts = [toast, ...toasts];
      emit();
    } else {
      const cards = [toast, ...toasts.filter((t) => t.kind !== 'undo')];
      const dropped = cards.slice(MAX_VISIBLE);
      for (const old of dropped) clearTimer(old.id);
      const droppedIds = new Set(dropped.map((old) => old.id));
      toasts = [toast, ...toasts.filter((t) => !droppedIds.has(t.id))];
      emit();
      // A toast pushed past the cap can no longer be undone: accept it.
      for (const old of dropped) runExpire(old.id);
    }

    if (timedMs !== null) {
      timers.set(
        id,
        setTimeout(() => expire(id), timedMs),
      );
    }
    return id;
  }

  function dispose(): void {
    for (const handle of timers.values()) clearTimeout(handle);
    timers.clear();
    expires.clear();
    listeners.clear();
    toasts = [];
  }

  return {
    show,
    dismiss,
    expire,
    act,
    dispose,
    getSnapshot: () => toasts,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

interface ToastContextValue extends ToastApi {
  toasts: ManagedToast[];
  expire: (id: string) => void;
  act: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/** Access show/dismiss from anywhere under <ToastProvider>. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return { show: ctx.show, dismiss: ctx.dismiss };
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<ToastStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = createToastStore();
  }
  const store = storeRef.current;
  const [toasts, setToasts] = useState<ManagedToast[]>(() => store.getSnapshot());

  useEffect(() => {
    setToasts(store.getSnapshot());
    const unsubscribe = store.subscribe(setToasts);
    return () => {
      unsubscribe();
      store.dispose();
    };
  }, [store]);

  const value = useMemo<ToastContextValue>(
    () => ({
      toasts,
      show: store.show,
      dismiss: store.dismiss,
      expire: store.expire,
      act: store.act,
    }),
    [toasts, store],
  );

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

/**
 * One top card with its motion (docs/motion.md, edgeStrip): rendered at rest,
 * it drops from the top edge on the first frame (320 ms); a swipe up follows
 * the finger and dismisses past TOAST_DISMISS_PX (or a flick), else springs
 * back; leaving, it goes back up the same way. Never a fade; with motion off
 * a leaving card is hidden at once.
 */
function ToastSlot({
  toast,
  onDismiss,
  onAction,
}: {
  toast: ManagedToast;
  onDismiss: (id: string) => void;
  onAction: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const off = useMotionOff();
  // Where a swipe left the card: the exit starts there.
  const fromY = useRef(0);

  useLayoutEffect(() => {
    stripIn(ref.current, 'top');
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!toast.leaving || el === null) return;
    stripOut(el, 'top', undefined, fromY.current);
    el.style.transform = '';
  }, [toast.leaving]);

  const drag = useDragDismiss({
    axis: 'y',
    direction: -1,
    closeAt: TOAST_DISMISS_PX,
    enabled: !toast.leaving,
    onMove: (offset) => {
      if (ref.current !== null) ref.current.style.transform = `translateY(${offset}px)`;
    },
    onDismiss: (offset) => {
      fromY.current = offset;
      onDismiss(toast.id);
    },
    onCancel: (offset) => {
      const el = ref.current;
      if (el === null) return;
      el.style.transform = '';
      if (offset !== 0) riseIn(el, offset);
    },
  });

  return (
    <div
      ref={ref}
      data-toast-slot=""
      className={cn(
        'pointer-events-auto flex w-full max-w-sm touch-none justify-center',
        toast.leaving && off && 'invisible',
      )}
      {...drag}
    >
      <Toast toast={toast} leaving={toast.leaving} onDismiss={onDismiss} onAction={onAction} />
    </div>
  );
}

/**
 * Fixed toast containers. Cards: mobile top, below the safe-area; desktop
 * (md+) top-right; newest on top (the store keeps newest first); each drops
 * from the top edge and leaves the same way (ToastSlot). Undo strips: the
 * bottom strip (UndoStrip), one live at a time.
 */
export function ToastViewport() {
  const ctx = useContext(ToastContext);
  if (ctx === null) return null;
  const cards = ctx.toasts.filter((toast) => toast.kind !== 'undo');
  const strips = ctx.toasts.filter((toast) => toast.kind === 'undo');
  return (
    <>
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 top-0 z-[70] flex flex-col items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:inset-x-auto md:right-4 md:items-end"
      >
        {cards.map((toast) => (
          <ToastSlot key={toast.id} toast={toast} onDismiss={ctx.expire} onAction={ctx.act} />
        ))}
      </div>
      {strips.map((toast) => (
        <UndoStrip
          key={toast.id}
          toast={toast}
          leaving={toast.leaving}
          onAccept={ctx.expire}
          onAction={ctx.act}
        />
      ))}
    </>
  );
}

/** As useToast, or null outside a ToastProvider (a sheet rendered on its own). */
export function useOptionalToast(): ToastApi | null {
  const ctx = useContext(ToastContext);
  return ctx === null ? null : { show: ctx.show, dismiss: ctx.dismiss };
}

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { Toast } from '@/components/ui/toast/Toast';
import { UndoStrip } from '@/components/ui/toast/UndoStrip';
import type { Toast as ToastModel, ToastApi, ToastOptions } from '@/components/ui/toast/types';
import { cn } from '@/lib/cn';
import { createPausableTimer, holdHandlers } from '@/lib/pausable-timer';
import type { HoldReason, PausableTimer } from '@/lib/pausable-timer';
import {
  DUR_SHEET_OUT_MS,
  motionOff,
  TOAST_DISMISS_PX,
  riseIn,
  stripIn,
  stripOut,
  useDragDismiss,
  useMotionOff,
} from '@/lib/motion';

/** Default auto-dismiss delay when `durationMs` is omitted. */
export const TOAST_MS = 4000;
/**
 * How long an error-tone toast stays up at least: a failure takes longer to
 * read and act on than a confirmation. Sticky error toasts stay sticky.
 */
export const ERROR_TOAST_MS = 8000;
/**
 * One top card at a time (12 Nov 2026): a new card replaces the live one at
 * once (no exit move, so two cards never overlap) and accepts it (onExpire).
 * A live error card is never replaced by a non-error card: that card waits
 * (newest only) and shows, with its full duration, once the error has gone.
 * A waiting card waits at most ERROR_TOAST_MS unless the error is sticky.
 */
export const MAX_VISIBLE = 1;
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
  /**
   * Hold (held true) or release a live toast's countdown for one reason
   * (hover, focus, press). It resumes with the time it had left once no reason
   * holds it. No-op for a leaving or sticky toast.
   */
  hold: (id: string, reason: HoldReason, held: boolean) => void;
  getSnapshot: () => ManagedToast[];
  subscribe: (listener: (toasts: ManagedToast[]) => void) => () => void;
  /** Clear every pending timer and listener. Called on provider unmount. */
  dispose: () => void;
}

export function createToastStore(): ToastStore {
  let toasts: ManagedToast[] = [];
  let seq = 0;
  const listeners = new Set<(toasts: ManagedToast[]) => void>();
  // One countdown per toast: its lifetime while live, then its exit removal.
  const timers = new Map<string, PausableTimer>();
  // onExpire per live toast; deleted when it fires or the action is pressed, so
  // it runs at most once.
  const expires = new Map<string, () => void>();
  // The newest non-error card held back by a live error card, with the
  // countdown it starts once shown. At most one; an older one is accepted.
  let waiting: { toast: ManagedToast; timedMs: number | null } | null = null;

  function emit(): void {
    for (const listener of listeners) listener(toasts);
  }

  function clearTimer(id: string): void {
    const timer = timers.get(id);
    if (timer !== undefined) {
      timer.cancel();
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
    showWaiting();
  }

  function startTimer(id: string, timedMs: number | null): void {
    if (timedMs !== null) {
      timers.set(
        id,
        createPausableTimer(() => expire(id), timedMs),
      );
    }
  }

  // The error card is gone and no card is up: the waiting card shows now,
  // with its full duration.
  function showWaiting(): void {
    if (waiting === null || toasts.some((toast) => toast.kind !== 'undo')) return;
    const { toast, timedMs } = waiting;
    waiting = null;
    toasts = [toast, ...toasts];
    emit();
    startTimer(toast.id, timedMs);
  }

  // Closing phase: flip the toast to `leaving` so its card plays the exit, then
  // remove it after EXIT_MS. Idempotent; the auto-dismiss timer is replaced by
  // the removal timer under the same id.
  function dismiss(id: string): void {
    // A card still waiting behind an error card just never shows.
    if (waiting !== null && waiting.toast.id === id) {
      waiting = null;
      return;
    }
    const current = toasts.find((toast) => toast.id === id);
    if (current === undefined || current.leaving) return;
    clearTimer(id);
    // Motion off (Reduce Motion, ?motion=0): there is no exit move to play,
    // so the card goes now rather than sitting hidden for EXIT_MS.
    if (motionOff()) {
      remove(id);
      return;
    }
    toasts = toasts.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast));
    emit();
    timers.set(
      id,
      createPausableTimer(() => remove(id), EXIT_MS),
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

  function hold(id: string, reason: HoldReason, held: boolean): void {
    const current = toasts.find((toast) => toast.id === id);
    if (current === undefined || current.leaving) return;
    const timer = timers.get(id);
    if (timer === undefined) return;
    if (held) timer.hold(reason);
    else timer.release(reason);
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
    const ms = options.durationMs === undefined ? TOAST_MS : options.durationMs;
    // An error toast never leaves before ERROR_TOAST_MS; sticky stays sticky.
    const floorMs = options.tone === 'error' ? ERROR_TOAST_MS : 0;
    const timedMs = ms !== null && ms > 0 ? Math.max(ms, floorMs) : null;
    if (options.onExpire !== undefined) expires.set(id, options.onExpire);

    // One strip at a time: a new Undo strip accepts the live one (commit now)
    // and lets it play its exit. The one-card rule never counts the strip.
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
      const liveError = toasts.some((t) => t.kind !== 'undo' && !t.leaving && t.tone === 'error');
      const older = waiting;
      if (liveError && toast.tone !== 'error') {
        // The error stays; this card waits (newest only) and the one it
        // pushes out of the wait is accepted, never shown.
        waiting = { toast, timedMs };
        if (older !== null) runExpire(older.toast.id);
        return id;
      }
      // A non-error card shown now is newer than any waiting one: accept it.
      // A new error keeps the waiting card behind it.
      if (toast.tone !== 'error') waiting = null;
      // Replace every card now, a leaving one included: no exit move, so two
      // cards never overlap. A live card pushed out is accepted.
      const replaced = toasts.filter((t) => t.kind !== 'undo');
      for (const old of replaced) clearTimer(old.id);
      toasts = [toast, ...toasts.filter((t) => t.kind === 'undo')];
      emit();
      for (const old of replaced) {
        if (old.leaving) expires.delete(old.id);
        else runExpire(old.id);
      }
      if (older !== null && waiting === null) runExpire(older.toast.id);
    }

    startTimer(id, timedMs);
    return id;
  }

  function dispose(): void {
    for (const timer of timers.values()) timer.cancel();
    timers.clear();
    expires.clear();
    listeners.clear();
    toasts = [];
    waiting = null;
  }

  return {
    show,
    dismiss,
    expire,
    act,
    hold,
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
  hold: (id: string, reason: HoldReason, held: boolean) => void;
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
      hold: store.hold,
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
  onHold,
}: {
  toast: ManagedToast;
  onDismiss: (id: string) => void;
  onAction: (id: string) => void;
  /** Holds the card's countdown while hovered, focused or touched. */
  onHold: (id: string, reason: HoldReason, held: boolean) => void;
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
  // Reading, focusing or touching the card holds its countdown (TOAST_MS).
  const holds = holdHandlers((reason, held) => onHold(toast.id, reason, held));

  return (
    <div
      ref={ref}
      data-toast-slot=""
      className={cn(
        'pointer-events-auto flex w-full max-w-sm touch-none justify-center',
        toast.leaving && off && 'invisible',
      )}
      {...drag}
      onPointerEnter={holds.onPointerEnter}
      onPointerLeave={holds.onPointerLeave}
      onFocus={holds.onFocus}
      onBlur={holds.onBlur}
      onPointerDown={(event) => {
        holds.onPointerDown();
        drag.onPointerDown(event);
      }}
    >
      <Toast toast={toast} leaving={toast.leaving} onDismiss={onDismiss} onAction={onAction} />
    </div>
  );
}

/**
 * The card container: top-14 is the 56 top bar (the 3.5rem in
 * --shell-sticky-top), then the safe area plus 12, so the card's top edge sits
 * 12 under the bar on every width; horizontal placement as before.
 */
export const TOAST_VIEWPORT_CLASS =
  'pointer-events-none fixed inset-x-0 top-14 z-toast flex flex-col items-center px-3 pt-[calc(env(safe-area-inset-top,0px)+0.75rem)] md:inset-x-auto md:right-4 md:items-end';

/**
 * Fixed toast containers. Cards: one at a time, its top edge 12 under the 56
 * top bar (top-14 = the bar, as --shell-sticky-top; safe area added), never
 * over the bar; phone centred, desktop (md+) right; it drops from above and
 * leaves the same way (ToastSlot). Undo strips: the bottom strip (UndoStrip),
 * one live at a time.
 */
export function ToastViewport() {
  const ctx = useContext(ToastContext);
  if (ctx === null) return null;
  const cards = ctx.toasts.filter((toast) => toast.kind !== 'undo');
  const strips = ctx.toasts.filter((toast) => toast.kind === 'undo');
  return (
    <>
      <div role="status" aria-live="polite" className={TOAST_VIEWPORT_CLASS}>
        {cards.map((toast) => (
          <ToastSlot
            key={toast.id}
            toast={toast}
            onDismiss={ctx.expire}
            onAction={ctx.act}
            onHold={ctx.hold}
          />
        ))}
      </div>
      {strips.map((toast) => (
        <UndoStrip
          key={toast.id}
          toast={toast}
          leaving={toast.leaving}
          onAccept={ctx.expire}
          onAction={ctx.act}
          onHold={ctx.hold}
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

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Toast } from '@/components/ui/toast/Toast';
import type { Toast as ToastModel, ToastApi, ToastOptions } from '@/components/ui/toast/types';

/** Default auto-dismiss delay when `durationMs` is omitted. */
export const DEFAULT_DURATION_MS = 5000;
/** Newest-first cap; older toasts beyond this are dropped on show(). */
export const MAX_VISIBLE = 3;

/** Slide-down enter for the cards, scoped to this surface (no color, no hex). */
const TOAST_KEYFRAMES =
  '@keyframes sorted-toast-in{from{opacity:0;transform:translateY(-0.5rem)}to{opacity:1;transform:translateY(0)}}';

/**
 * Framework-agnostic toast core. Owns the list and one timer per toast so the
 * provider stays a thin React mirror and the behaviour is unit-testable with
 * fake timers (mirrors createLongPressController). State is in memory only;
 * nothing touches localStorage/sessionStorage.
 */
export interface ToastStore extends ToastApi {
  getSnapshot: () => ToastModel[];
  subscribe: (listener: (toasts: ToastModel[]) => void) => () => void;
  /** Clear every pending timer and listener. Called on provider unmount. */
  dispose: () => void;
}

export function createToastStore(): ToastStore {
  let toasts: ToastModel[] = [];
  let seq = 0;
  const listeners = new Set<(toasts: ToastModel[]) => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

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

  function dismiss(id: string): void {
    clearTimer(id);
    const next = toasts.filter((toast) => toast.id !== id);
    if (next.length !== toasts.length) {
      toasts = next;
      emit();
    }
  }

  function show(options: ToastOptions): string {
    const id = String((seq += 1));
    const toast: ToastModel = {
      id,
      title: options.title,
      ...(options.description !== undefined ? { description: options.description } : {}),
      ...(options.icon !== undefined ? { icon: options.icon } : {}),
      ...(options.onPress !== undefined ? { onPress: options.onPress } : {}),
    };

    const kept = [toast, ...toasts];
    for (const dropped of kept.slice(MAX_VISIBLE)) clearTimer(dropped.id);
    toasts = kept.slice(0, MAX_VISIBLE);
    emit();

    const ms = options.durationMs === undefined ? DEFAULT_DURATION_MS : options.durationMs;
    if (ms !== null && ms > 0) {
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          dismiss(id);
        }, ms),
      );
    }
    return id;
  }

  function dispose(): void {
    for (const handle of timers.values()) clearTimeout(handle);
    timers.clear();
    listeners.clear();
    toasts = [];
  }

  return {
    show,
    dismiss,
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
  toasts: ToastModel[];
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
  const [toasts, setToasts] = useState<ToastModel[]>(() => store.getSnapshot());

  useEffect(() => {
    setToasts(store.getSnapshot());
    const unsubscribe = store.subscribe(setToasts);
    return () => {
      unsubscribe();
      store.dispose();
    };
  }, [store]);

  const value = useMemo<ToastContextValue>(
    () => ({ toasts, show: store.show, dismiss: store.dismiss }),
    [toasts, store],
  );

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

/**
 * Fixed toast container. Mobile: top, below the safe-area, slide-down enter.
 * Desktop (md+): top-right. Newest on top (the store keeps newest first).
 */
export function ToastViewport() {
  const ctx = useContext(ToastContext);
  if (ctx === null) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-0 z-[70] flex flex-col items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:inset-x-auto md:right-4 md:items-end"
    >
      <style>{TOAST_KEYFRAMES}</style>
      {ctx.toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={ctx.dismiss} />
      ))}
    </div>
  );
}

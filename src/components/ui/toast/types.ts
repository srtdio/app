import type { ReactNode } from 'react';

/** A toast's tint. */
export type ToastTone = 'success';

/** An optional trailing action on a toast (e.g. Undo): pressing it also dismisses the toast. */
export interface ToastAction {
  label: string;
  onPress: () => void;
}

/** Caller-supplied options for a single toast. */
export interface ToastOptions {
  title: string;
  description?: string;
  icon?: ReactNode;
  onPress?: () => void;
  /** A trailing 44px action button (e.g. Undo). */
  action?: ToastAction;
  /** 'success' tints the card with the success tokens. Omitted: neutral. */
  tone?: ToastTone;
  /**
   * Auto-dismiss delay in milliseconds. Omitted falls back to the default
   * (5000ms). `0` or `null` makes the toast sticky (no auto-dismiss).
   */
  durationMs?: number | null;
}

/** A live toast held by the provider. `id` is assigned on show(). */
export interface Toast {
  id: string;
  title: string;
  description?: string;
  icon?: ReactNode;
  onPress?: () => void;
  action?: ToastAction;
  tone?: ToastTone;
}

/** Public surface returned by useToast(). */
export interface ToastApi {
  /** Queue a toast. Returns its id so the caller can dismiss it early. */
  show: (options: ToastOptions) => string;
  /** Remove a toast by id (no-op if already gone). */
  dismiss: (id: string) => void;
}

import type { ReactNode } from 'react';

/** Caller-supplied options for a single toast. */
export interface ToastOptions {
  title: string;
  description?: string;
  icon?: ReactNode;
  onPress?: () => void;
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
}

/** Public surface returned by useToast(). */
export interface ToastApi {
  /** Queue a toast. Returns its id so the caller can dismiss it early. */
  show: (options: ToastOptions) => string;
  /** Remove a toast by id (no-op if already gone). */
  dismiss: (id: string) => void;
}

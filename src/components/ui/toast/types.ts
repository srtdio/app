import type { ReactNode } from 'react';

/** A toast's tint. */
export type ToastTone = 'success';

/** A toast's surface. Omitted: the top card. */
export type ToastKind = 'undo';

/**
 * An optional trailing action on a toast (e.g. Undo): pressing it runs onPress,
 * then dismisses the toast without calling onExpire.
 */
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
  /**
   * Called once when the toast ends without its action: the auto-dismiss timer
   * runs out, the X is pressed (closing = accept), or a newer toast pushes it
   * past the cap. Never called after the action is pressed.
   */
  onExpire?: () => void;
  /**
   * 'undo' renders the toast as the bottom Undo strip instead of the top card.
   * One strip at a time: a newer one accepts (onExpire) the one it replaces.
   */
  kind?: ToastKind;
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
  kind?: ToastKind;
}

/** Public surface returned by useToast(). */
export interface ToastApi {
  /** Queue a toast. Returns its id so the caller can dismiss it early. */
  show: (options: ToastOptions) => string;
  /** Remove a toast by id (no-op if already gone). */
  dismiss: (id: string) => void;
}

import { cn } from '@/lib/cn';

/**
 * The shared floating-menu container: the chat row menu, the message actions
 * panel and the attachment menu. Motion is opacity + scale only (no
 * translation), entering on ease-enter and leaving on ease-exit.
 */
const POPOVER_PANEL =
  'lit-overlay rounded-xl border bg-panel p-1.5 transition-[opacity,transform] duration-fast';

/** The panel classes for the entered (shown) or exiting (hidden) phase. */
export function popoverClass(shown: boolean): string {
  return cn(
    POPOVER_PANEL,
    shown ? 'scale-100 opacity-100' : 'scale-[0.96] opacity-0',
  );
}

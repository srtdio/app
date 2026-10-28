// The search shortcut: Cmd+K on Apple platforms, Ctrl+K elsewhere, never while
// typing in another text field. Pure, so the shell's key handler is unit-tested.

/** Whether the platform's command key is Cmd (Apple) rather than Ctrl. Pure. */
export function usesCmdKey(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

/** Cmd+K on Apple platforms, Ctrl+K elsewhere (no Alt, no Shift, not the other modifier). Pure. */
export function isPaletteShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  cmdKey: boolean,
): boolean {
  // Android Chrome autofill fires keydown with no key: never a shortcut.
  if (typeof event.key !== 'string') return false;
  if (event.key.toLowerCase() !== 'k' || event.altKey || event.shiftKey) return false;
  return cmdKey ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** Whether a key event comes from a text field (typing there never opens search). Pure. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color'].includes(
    target.type,
  );
}

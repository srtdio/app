/** Copy failure feedback, shown at every copy site. */
export const COPY_FAILED = "Couldn't copy";

/** Copy text to the clipboard. Resolves false (never throws) when the clipboard is unavailable or refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !('clipboard' in navigator)) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

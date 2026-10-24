// Web font warm-up. Inter loads with the first text on screen, but JetBrains
// Mono (chat times, dates and counts) only starts loading when the first mono
// text renders: in a thread that is the first bubble's time, so the face would
// swap in a moment after the messages paint and re-wrap bubbles (the card and
// the thread move). Asking for it at boot has it ready before any chat paints.

/** The mono faces chat uses, with the characters a time, date or count needs. */
const MONO_FACES = ['400 1em "JetBrains Mono"', '500 1em "JetBrains Mono"'] as const;
const MONO_SAMPLE = '0123456789:/ APMaprmonthOctSeen';

/** Start loading the mono faces now. Safe without `document.fonts` (tests, SSR). */
export function warmMonoFont(
  fonts: FontFaceSet | undefined = typeof document !== 'undefined' ? document.fonts : undefined,
): void {
  if (fonts === undefined) return;
  for (const face of MONO_FACES) {
    void fonts.load(face, MONO_SAMPLE).catch(() => undefined);
  }
}

import { extendTailwindMerge } from 'tailwind-merge';

// tailwind-merge v2 (Tailwind 3), taught this repo's custom scale so a later
// class wins over an earlier one of the same group regardless of CSS order:
// - text-xs..3xl, text-md, text-input and text-legacy-* are SIZES (without this
//   twMerge would read text-md as a colour and drop text-fg beside it);
// - text-fg / fg-2 / fg-3 / accent / strip / overlay-* stay COLOURS (default);
// - rounded-card / sheet / pill / inset are radii; bg-good-tint / bg-on-bubble-hover
//   are background images (they never drop a bg colour);
// - lit-* and mv-* are not Tailwind utilities, so twMerge never drops them.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'xs',
            'sm',
            'md',
            'base',
            'lg',
            'xl',
            '2xl',
            '3xl',
            'input',
            'legacy-xs',
            'legacy-sm',
            'legacy-base',
            'legacy-lg',
            'legacy-xl',
            'legacy-2xl',
            'legacy-3xl',
          ],
        },
      ],
      rounded: [{ rounded: ['card', 'sheet', 'pill', 'inset'] }],
      // backgroundImage tokens (tailwind.config.ts): never a bg colour, so
      // bg-transparent beside bg-on-bubble-hover is kept.
      'bg-image': [{ bg: ['good-tint', 'on-bubble-hover'] }],
    },
  },
});

/**
 * Join class parts and merge Tailwind conflicts: the LAST class of a group wins
 * (cn('p-4', 'p-3') === 'p-3'), so a call site's className reliably overrides a
 * part's base. Falsy parts are skipped. twMerge caches its results (LRU 500).
 */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return twMerge(parts.filter(Boolean).join(' '));
}

import { extendTailwindMerge, validators } from 'tailwind-merge';

// Class merge: when two classes set the same thing (p-4 then p-3), the later
// one wins and the earlier one is dropped, so a call site's className really
// overrides a shared part's default instead of racing it in stylesheet order.
//
// tailwind-merge only knows stock Tailwind, so Sorted's own scale is taught
// here (keep in step with tailwind.config.ts):
// - fontSize: text-md, text-input and text-legacy-* are SIZES; every other
//   text-<token> (text-fg, text-fg-2, text-accent, text-strip...) is a COLOUR.
// - borderRadius: rounded-card, rounded-sheet, rounded-pill are radii.
// - backgroundImage: bg-good-tint, bg-on-bubble-hover are images, so they sit
//   on top of a bg-<colour> instead of replacing it.
// - transition tokens: duration-<token>, ease-<token>.
// lit-* and mv-* are plain classes from src/index.css; tailwind-merge does not
// know them, so it never drops them (cn.test.ts proves it).
const FONT_SIZES = [
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
];

const DURATIONS = [
  'fast',
  'base',
  'slow',
  'push',
  'back',
  'grow',
  'grow-back',
  'sheet-in',
  'sheet-out',
  'menu',
  'toast',
  'wipe',
  'sweep',
];

const EASES = ['enter', 'exit', 'ios', 'move', 'pop'];

const merge = extendTailwindMerge({
  override: {
    classGroups: {
      // Arbitrary lengths (text-[11px]) stay sizes, as in stock tailwind-merge.
      'font-size': [{ text: [...FONT_SIZES, validators.isArbitraryLength] }],
    },
    // Stock tailwind-merge drops an earlier leading-* when a text size follows.
    // In Sorted's stylesheet leading-* always beats the size's own line
    // height, so keep both and let CSS decide as it did before.
    conflictingClassGroups: {
      'font-size': [],
    },
  },
  extend: {
    theme: {
      borderRadius: ['card', 'sheet', 'pill'],
    },
    classGroups: {
      'bg-image': [{ bg: ['good-tint', 'on-bubble-hover'] }],
      duration: [{ duration: DURATIONS }],
      ease: [{ ease: EASES }],
    },
  },
});

export function cn(...parts: Array<string | false | null | undefined>): string {
  return merge(...parts.filter(Boolean));
}

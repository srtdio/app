import { extendTailwindMerge } from 'tailwind-merge';

// tailwind-merge v2 (Tailwind 3), taught this repo's custom scale so a later
// class wins over an earlier one of the same group regardless of CSS order:
// - text-xs..3xl, text-md and text-input are SIZES (without this twMerge would
//   read text-md as a colour and drop text-fg beside it);
// - text-fg / fg-2 / fg-3 / accent / strip / overlay-* stay COLOURS (default);
// - rounded-card / sheet / pill / inset are radii; bg-good-tint / bg-on-bubble-hover
//   are background images (they never drop a bg colour);
// - the named tokens of tailwind.config.ts (z-sheet, w-side-panel, h-dense,
//   mr-plan-panel, py-field-y, border-cutout, leading-emoji, tracking-label) join
//   their groups, so a later one still wins and border-cutout is never read as a colour;
// - lit-* and mv-* are not Tailwind utilities, so twMerge never drops them.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: ['xs', 'sm', 'md', 'base', 'lg', 'xl', '2xl', '3xl', 'input', 'msg'],
        },
      ],
      rounded: [{ rounded: ['card', 'sheet', 'pill', 'inset'] }],
      z: [
        {
          z: [
            'base',
            'raised',
            'sticky',
            'nav',
            'dock',
            'sheet',
            'guide',
            'picker-catch',
            'picker',
            'dialog',
            'toast',
            'viewer',
            'top',
          ],
        },
      ],
      w: [
        {
          w: [
            'chat-list',
            'emoji',
            'emoji-tray',
            'plan-narrow',
            'plan-panel',
            'schedule',
            'sheet',
            'sheet-wide',
            'side-panel',
            'rail-glyph',
          ],
        },
      ],
      h: [{ h: ['emoji', 'dense', 'rail-glyph'] }],
      mr: [{ mr: ['plan-panel'] }],
      py: [{ py: ['field-y'] }],
      'border-w': [{ border: ['cutout', 'cutout-lg'] }],
      'border-w-l': [{ 'border-l': ['rail'] }],
      leading: [{ leading: ['emoji'] }],
      tracking: [{ tracking: ['label'] }],
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

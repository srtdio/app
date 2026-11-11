import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { Text } from '@/components/ui/Text';

/**
 * 'field' (default): a field the person must fill (forms, code boxes, add-task
 * row): the ink line at rest. 'search': a tool, quiet at rest (a filled well,
 * no line); focused it becomes the centre: ink line, lit-focus, and the
 * surface lifts to lit-card on bg-panel. The lift and line are instant.
 */
export type InputTone = 'field' | 'search';

/**
 * Switched off (11 Nov 2026), the one field look: the ink line drops to the
 * grey edge, text and placeholder fg-3, default cursor. Never a fade.
 */
export const FIELD_DISABLED =
  'disabled:border-border-strong disabled:text-fg-3 disabled:placeholder:text-fg-3 disabled:cursor-default';

// Default field: the ink line at rest; switched off, FIELD_DISABLED.
const FIELD = `lit-well w-full h-11 px-3 rounded-lg border border-field bg-panel-2 text-fg text-input md:text-base placeholder:text-fg-3 outline-none focus:lit-focus ${FIELD_DISABLED}`;

// One clear X per search field (B1): the field's own IconButton. WebKit's
// native type="search" cancel glyph (the second, backspace-like X) is hidden.
export const SEARCH_ONE_CLEAR =
  '[&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none';

export const INPUT_TONE: Record<InputTone, string> = {
  field: FIELD,
  search:
    'lit-well w-full h-11 px-3 rounded-lg border border-transparent bg-panel-2 text-fg text-input md:text-base placeholder:text-fg-3 outline-none focus:lit-focus disabled:text-fg-3 caret-fg focus:border-field focus:bg-panel focus:lit-card ' +
    SEARCH_ONE_CLEAR,
};

/** The text end kept clear for the counter ("25/25" in meta mono) so typing never runs under it. */
export const INPUT_COUNTER_ROOM = 'pr-16';

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  tone?: InputTone;
  /**
   * A live length counter ("20/25") at the field's trailing edge, in the meta
   * role. Pass the prop (null while hidden) to reserve its room and keep the
   * polite live region mounted, so the field never changes size when it shows.
   * Omitted: the plain input, exactly as before.
   */
  counter?: string | null;
};

// 16px text below md so iOS Safari does not zoom the page when the field takes
// focus; the usual 14px from md up.
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, tone = 'field', counter, ...props },
  ref,
) {
  if (counter === undefined) {
    return <input ref={ref} className={cn(INPUT_TONE[tone], className)} {...props} />;
  }
  return (
    <div className="relative">
      <input ref={ref} className={cn(INPUT_TONE[tone], INPUT_COUNTER_ROOM, className)} {...props} />
      <Text
        role="meta"
        aria-live="polite"
        data-input-counter=""
        className="pointer-events-none absolute inset-y-0 right-3 flex items-center"
      >
        {counter ?? ''}
      </Text>
    </div>
  );
});

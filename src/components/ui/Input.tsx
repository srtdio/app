import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * 'field' (default): a field the person must fill (forms, code boxes, add-task
 * row): the ink line at rest. 'search': a tool, quiet at rest (a filled well,
 * no line); focused it becomes the centre: ink line, lit-focus, and the
 * surface lifts to lit-card on bg-panel. The lift and line are instant.
 */
export type InputTone = 'field' | 'search';

const BASE =
  'w-full h-11 px-3 rounded-lg border text-fg text-input md:text-base placeholder:text-fg-3 outline-none focus:lit-focus disabled:text-fg-3';

export const INPUT_TONE: Record<InputTone, string> = {
  field: 'lit-well border-field bg-panel-2',
  search:
    'lit-well border-transparent bg-panel-2 caret-fg focus:border-field focus:bg-panel focus:lit-card',
};

// 16px text below md so iOS Safari does not zoom the page when the field takes
// focus; the usual 14px from md up.
export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { tone?: InputTone }
>(function Input({ className, tone = 'field', ...props }, ref) {
  return <input ref={ref} className={cn(INPUT_TONE[tone], BASE, className)} {...props} />;
});

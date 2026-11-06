import type { InputHTMLAttributes, ReactElement } from 'react';
import { IconCheck, ICON_SIZE } from '@/components/ui/icons';

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'>;

// The one checkbox: a native <input type="checkbox"> (keyboard, label and form
// behaviour stay the browser's) drawn as a 20px box. At rest a field: lit-well,
// border-field, panel-2. Checked: the accent fill with an accent-fg tick. The
// call site's <label> carries the 44px tap target and the visible text.
export function Checkbox(props: CheckboxProps): ReactElement {
  return (
    <span className="relative inline-flex h-5 w-5 shrink-0">
      <input
        {...props}
        type="checkbox"
        className="peer m-0 h-5 w-5 shrink-0 cursor-pointer appearance-none rounded-sm border border-field bg-panel-2 lit-well mv-tint checked:border-transparent checked:bg-accent focus-visible:lit-focus disabled:cursor-default"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 hidden items-center justify-center text-accent-fg peer-checked:flex"
      >
        <IconCheck size={ICON_SIZE.text} />
      </span>
    </span>
  );
}

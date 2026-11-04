// The one on/off switch, the "ink pill": a 51x31 pill centred in a 44px-tall
// button (role="switch"), so the tap target stays 44 tall while hover, press
// and the focus line follow the pill, not the row. Off: a clear track with a
// 1.5px field line (ink light, white dark), lit-well, and an ink knob. On: the
// accent fill, no line, an accent-fg knob. Only the knob moves (translateX,
// mv-slide). The call site lays out its label; `label` names the switch for
// assistive tech. A raw <button> (ui/ owns the primitives): PressableRow would
// paint its hover and focus on the 44px row.
import type { ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { MOVE_CLASS } from '@/lib/motion';

export interface SwitchProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  /** Accessible name; usually the visible row label. */
  label: string;
}

export function Switch({ checked, onChange, label }: SwitchProps): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      // The 44px hit row: no look of its own; the focus line is drawn on the
      // pill (group-focus-visible:lit-focus), so the row drops the UA outline.
      className={cn(
        'group inline-flex h-11 min-h-[44px] w-auto shrink-0 items-center rounded-full outline-none',
        MOVE_CLASS.press,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'relative inline-flex h-[31px] w-[51px] items-center rounded-full border-[1.5px] px-[2.5px] lit-well lit-hover group-focus-visible:lit-focus',
          MOVE_CLASS.tint,
          checked ? 'border-transparent bg-accent' : 'border-field bg-transparent',
        )}
      >
        <span
          className={cn(
            'h-[23px] w-[23px] rounded-full lit-knob',
            MOVE_CLASS.slide,
            checked ? 'bg-accent-fg' : 'bg-fg',
            // 51 - 3 (border) - 5 (px-[2.5px]) - 23 (knob) = 20.
            checked ? 'translate-x-5' : 'translate-x-0',
          )}
        />
      </span>
    </button>
  );
}

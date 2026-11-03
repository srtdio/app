// The one on/off switch: a PressableRow with role="switch" around a pill
// track (lit-well) and a knob (lit-knob). The whole 44px-tall track is the
// tap target; only the knob moves (translateX). The call site lays out its
// label; `label` names the switch for assistive tech.
import type { ReactElement } from 'react';
import { PressableRow } from '@/components/ui/PressableRow';
import { cn } from '@/lib/cn';

export interface SwitchProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  /** Accessible name; usually the visible row label. */
  label: string;
}

export function Switch({ checked, onChange, label }: SwitchProps): ReactElement {
  return (
    <PressableRow
      inline
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="inline-flex shrink-0 items-center"
    >
      {/* The track keeps the pill shape; the row stays the plain primitive. */}
      <span
        aria-hidden
        className={cn(
          'relative inline-flex h-11 w-[60px] items-center rounded-full px-1 lit-well transition-colors motion-reduce:transition-none',
          checked ? 'bg-accent' : 'bg-panel-3',
        )}
      >
        <span
          className={cn(
            'h-7 w-7 rounded-full bg-panel lit-knob transition-transform motion-reduce:transition-none',
            checked ? 'translate-x-[24px]' : 'translate-x-0',
          )}
        />
      </span>
    </PressableRow>
  );
}

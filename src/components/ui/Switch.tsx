// The one on/off switch: a PressableRow with role="switch" around a pill
// track (lit-well) and a knob (bg-knob lit-knob). The whole 44px-tall track is the
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
      // rounded-full: hover and the focus line follow the pill, not a rectangle.
      className="inline-flex shrink-0 items-center rounded-full"
    >
      {/* Off: a panel-2 well with a 3:1 border-strong edge. On: the accent fill.
          The knob (bg-knob) is lighter than the track in both themes and keeps a
          border-strong ring (a border, so lit-knob's shadow stays). */}
      <span
        aria-hidden
        className={cn(
          'relative inline-flex h-11 w-[60px] items-center rounded-full border px-1 lit-well mv-tint',
          checked ? 'border-transparent bg-accent' : 'border-border-strong bg-panel-2',
        )}
      >
        <span
          className={cn(
            'h-7 w-7 rounded-full border border-border-strong bg-knob lit-knob mv-slide',
            // 60 - 2 (border) - 8 (px-1) - 28 (knob) = 22.
            checked ? 'translate-x-[22px]' : 'translate-x-0',
          )}
        />
      </span>
    </PressableRow>
  );
}

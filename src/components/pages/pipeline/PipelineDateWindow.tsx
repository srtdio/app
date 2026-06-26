import type { ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { IconCalendar } from '@/components/ui/icons';
import { DATE_WINDOW_OPTIONS, type DateWindow } from '@/lib/list-sort';

interface PipelineDateWindowProps {
  value: DateWindow;
  onChange: (next: DateWindow) => void;
}

/**
 * The Pipeline-only target-date window control: a leading muted calendar glyph
 * and a connected segmented track of the three {@link DATE_WINDOW_OPTIONS}. Pure
 * presentation; it calls {@link PipelineDateWindowProps.onChange} and never
 * filters. The active segment reads as the elevated card token (`bg-panel`) above
 * the recessed track (`bg-panel-2`) and carries the accent text, so light and dark
 * both render the selection from tokens with no hardcoded colour. Only colour and
 * background animate (transition-colors) so the active state cannot slide or scale.
 */
export function PipelineDateWindow({ value, onChange }: PipelineDateWindowProps): ReactElement {
  return (
    <div className="flex items-center gap-2">
      <IconCalendar size={18} className="text-fg-3 shrink-0" />
      <div
        role="radiogroup"
        aria-label="Filter by target date"
        className="inline-flex rounded-lg bg-panel-2 p-0.5"
      >
        {DATE_WINDOW_OPTIONS.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(option.value)}
              className={cn(
                'min-h-[44px] md:h-9 px-3 rounded-md text-sm transition-colors',
                active
                  ? 'bg-panel text-accent font-semibold shadow-sm'
                  : 'text-fg-3 hover:text-fg-2',
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

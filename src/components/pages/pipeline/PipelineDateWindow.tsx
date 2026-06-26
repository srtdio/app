import { IconCalendar } from '@/components/ui/icons';
import { DATE_WINDOW_OPTIONS, type DateWindow } from '@/lib/list-sort';

interface PipelineDateWindowProps {
  value: DateWindow;
  onChange: (next: DateWindow) => void;
}

/**
 * Pipeline-only segmented control for the target-date window. Reads the same on
 * desktop (kanban) and mobile (feed): a leading muted calendar glyph then a
 * connected three-segment track on a recessed surface. Left-aligned and compact
 * at every width (it never stretches full width on desktop). The active segment
 * is the elevated card token with accent text; the change is background/colour
 * only (transition-colors), no sliding pill or transform. Purely presentational:
 * it calls onChange and never filters. Token classes only, so light and dark both
 * render the selection from tokens.
 */
export function PipelineDateWindow({ value, onChange }: PipelineDateWindowProps) {
  return (
    <div className="flex items-center gap-2">
      <IconCalendar size={16} className="text-fg-3 shrink-0" />
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
              className={`min-h-[44px] md:h-9 rounded-md px-3 text-sm transition-colors ${
                active
                  ? 'bg-panel text-accent font-semibold shadow-sm'
                  : 'text-fg-3 hover:text-fg-2'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

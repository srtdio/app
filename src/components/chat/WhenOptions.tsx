// The one "when" picker frame for the chat's time sheets: Remind me
// (ReminderSheet) and Schedule message (ScheduleSheet and its laptop menu).
// Both used to build it twice; this part owns it once: the caller's preview
// line, the preset rows (a 44 icon disc, the label, the time in mono or a
// chevron), the caller's extra rows (change mode's Cancel reminder), and the
// Custom step (native date and time inputs, 1 minute to 365 days ahead, a
// summary line, the helper, the confirm button). The caller names its hooks
// (`hook`), so data-reminder-* / data-schedule-* stay as they were. Pure
// render plus the step and the two field values; no reads, no waits.

import { useState } from 'react';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { PressableRow } from '@/components/ui/PressableRow';
import { ICON_SIZE, IconChevronRight, type IconProps } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { dateInputValue, fromInputs, MAX_LEAD_MS, timeInputValue } from '@/lib/chat/scheduled';

/** One preset row: its id (the row hook), label, right text (mono time) and pick. */
export interface WhenPreset {
  id: string;
  label: string;
  /** The time in mono on the right; without it the row shows a chevron (it opens a step). */
  detail?: string;
  onPick: () => void;
}

export interface WhenOptionsProps {
  /** The data-* hook prefix: data-{hook}-options, -row, -custom, -summary, -confirm. */
  hook: 'reminder' | 'schedule';
  /** The line above the rows (the message or draft it is for); the caller owns its look. */
  preview?: ReactNode;
  /** The rows' glyph (alarm clock for reminders, calendar clock for scheduling). */
  icon: ComponentType<IconProps>;
  presets: readonly WhenPreset[];
  /** The last preset row's label, which opens the Custom step ("Custom", "Custom time"). */
  customLabel: string;
  /** Rows after Custom (change mode's Cancel reminder). */
  extraRows?: ReactNode;
  /** Set: the rows are a role="menu" with this name (the laptop Schedule menu's arrow keys). */
  menuLabel?: string;
  custom: {
    /** The fields' starting value (tomorrow at 9:00 AM). */
    initial: Date;
    /** The line under the fields for the chosen moment. */
    summary: (chosen: Date, now: Date) => string;
    /** Whether a chosen moment may be picked. */
    allowed: (chosen: Date, now: Date) => boolean;
    helper: string;
    confirmLabel: string;
    onPick: (chosen: Date) => void;
  };
}

function hookAttr(hook: string, name: string, value: string): Record<`data-${string}`, string> {
  return { [`data-${hook}-${name}`]: value };
}

/** The rows and the Custom step: the one frame for every chat time pick. */
export function WhenOptions(props: WhenOptionsProps): ReactElement {
  const { hook, custom } = props;
  const [step, setStep] = useState<'presets' | 'custom'>('presets');
  const now = new Date();
  const [date, setDate] = useState(() => dateInputValue(custom.initial));
  const [time, setTime] = useState(() => timeInputValue(custom.initial));
  const chosen = fromInputs(date, time);
  const valid = chosen !== null && custom.allowed(chosen, now);
  const menuLabel = props.menuLabel;
  const menu = menuLabel !== undefined;
  const Icon = props.icon;

  return (
    <div {...hookAttr(hook, 'options', step)} className={cn('flex flex-col', NO_TOUCH_SELECT)}>
      {props.preview ?? null}
      {step === 'presets' ? (
        <ul
          {...(menuLabel !== undefined ? { role: 'menu', 'aria-label': menuLabel } : {})}
          className="flex flex-col"
        >
          {props.presets.map((preset) => (
            <WhenRow
              key={preset.id}
              hook={hook}
              id={preset.id}
              icon={<Icon size={ICON_SIZE.control} />}
              label={preset.label}
              menu={menu}
              onClick={preset.onPick}
              {...(preset.detail !== undefined ? { detail: preset.detail } : {})}
            />
          ))}
          <WhenRow
            hook={hook}
            id="custom"
            icon={<Icon size={ICON_SIZE.control} />}
            label={props.customLabel}
            menu={menu}
            onClick={() => setStep('custom')}
          />
          {props.extraRows ?? null}
        </ul>
      ) : (
        <div {...hookAttr(hook, 'custom', '')} className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-sm font-medium text-fg-2">
              Date
              <Input
                type="date"
                aria-label="Date"
                value={date}
                min={dateInputValue(now)}
                max={dateInputValue(new Date(now.getTime() + MAX_LEAD_MS))}
                onChange={(event) => setDate(event.target.value)}
                className="min-w-0 font-mono"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-fg-2">
              Time
              <Input
                type="time"
                aria-label="Time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
                className="min-w-0 font-mono"
              />
            </label>
          </div>
          <p {...hookAttr(hook, 'summary', '')} className="min-h-5 text-base font-medium text-fg">
            {chosen !== null ? custom.summary(chosen, now) : ''}
          </p>
          <p className="text-sm text-fg-3">{custom.helper}</p>
          <Button
            type="button"
            variant="primary"
            {...hookAttr(hook, 'confirm', '')}
            disabled={!valid}
            onClick={() => {
              if (chosen !== null && custom.allowed(chosen, new Date())) custom.onPick(chosen);
            }}
          >
            {custom.confirmLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * One row of the frame, also the shape of a caller's extra row: 56 tall, a 44
 * disc holding the 20 glyph, the label, then the time in mono or a chevron.
 * `tone="danger"` is change mode's Cancel reminder (bad ink, bad-soft disc,
 * no right text), `divided` sets it apart from the presets.
 */
export function WhenRow(props: {
  hook: 'reminder' | 'schedule';
  id: string;
  icon: ReactNode;
  label: string;
  detail?: string;
  menu?: boolean;
  tone?: 'danger';
  /** A divider above the row, set apart from the presets (Cancel reminder). */
  divided?: boolean;
  onClick: () => void;
}): ReactElement {
  const danger = props.tone === 'danger';
  return (
    <li
      {...(props.menu === true ? { role: 'none' } : {})}
      {...(props.divided === true ? { className: 'mt-1 border-t border-border pt-1' } : {})}
    >
      <PressableRow
        type="button"
        {...(props.menu === true ? { role: 'menuitem' } : {})}
        {...hookAttr(props.hook, 'row', props.id)}
        onClick={props.onClick}
        className={cn(
          'flex min-h-14 items-center gap-3 px-2',
          danger ? 'text-bad hover:bg-bad-soft' : 'text-fg',
        )}
      >
        <span
          className={cn(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-full',
            danger ? 'bg-bad-soft text-bad lit-tint' : 'bg-panel-2 text-fg-2 lit-btn-secondary',
          )}
        >
          {props.icon}
        </span>
        <span className="flex-1 text-lg font-medium">{props.label}</span>
        {danger ? null : props.detail !== undefined ? (
          <span className="font-mono text-sm tabular-nums text-fg-2">{props.detail}</span>
        ) : (
          <IconChevronRight size={ICON_SIZE.inline} className="text-fg-3" />
        )}
      </PressableRow>
    </li>
  );
}

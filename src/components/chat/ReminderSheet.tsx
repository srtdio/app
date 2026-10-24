// The "Remind me" sheet: the message preview, then the presets (20 minutes,
// 1 hour, 3 hours, Tomorrow 9:00 AM, Next week on Monday 9:00 AM) and Custom,
// the same Custom step as the Schedule sheet (native date and time inputs, 1
// minute to 365 days ahead). Device-local times in mono, the zone named in the
// footer from Intl. Used for a new reminder and, in change mode (a reminder is
// already pending: "Reminder · <time>" from the message menu), titled
// "Reminder" with a "Cancel reminder" row in the danger token under the
// presets. ChatReminderSheet is the one the chat mounts, wired to the
// ReminderProvider. Tokens only; the Sheet moves on translateY only.

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import { ICON_SIZE, IconAlarmClock, IconChevronRight, IconX } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { useReminderOptional } from '@/components/chat/ReminderContext';
import { zoneLine } from '@/components/chat/ScheduleSheet';
import {
  dateInputValue,
  formatDayTime,
  fromInputs,
  MAX_LEAD_MS,
  timeInputValue,
} from '@/lib/chat/scheduled';
import {
  isWithinReminderWindow,
  reminderPresets,
  reminderSummary,
  type ReminderPreset,
} from '@/lib/chat/reminders';
import { useHistoryStep } from '@/lib/chat/use-history-step';
import { SHEET_STEP_KEYS } from '@/lib/chat/sheet-steps';

export const REMINDER_SHEET_TITLE = 'Remind me';
/** The sheet's title while a reminder is pending (change mode). */
export const REMINDER_CHANGE_TITLE = 'Reminder';
export const CANCEL_REMINDER_LABEL = 'Cancel reminder';
export const REMINDER_HELPER = 'Any time from 1 minute to 1 year ahead.';

/** A preset row's right text: "3:20 PM" today, else "Sun 4 Oct, 9:00 AM". Pure. */
export function presetDetail(preset: ReminderPreset, now: Date): string {
  const sameDay =
    preset.at.getFullYear() === now.getFullYear() &&
    preset.at.getMonth() === now.getMonth() &&
    preset.at.getDate() === now.getDate();
  const full = formatDayTime(preset.at, now);
  return sameDay ? (full.split(', ')[1] ?? full) : full;
}

/** The rows and the Custom step. */
export function ReminderOptions(props: {
  preview: string | null;
  onPick: (at: Date) => void;
  /** Change mode: a "Cancel reminder" row after the presets. */
  onCancelReminder?: (() => void) | undefined;
}): ReactElement {
  const [step, setStep] = useState<'presets' | 'custom'>('presets');
  const now = new Date();
  const presets = reminderPresets(now);
  const tomorrow = presets.find((p) => p.id === 'tomorrow')?.at ?? now;
  const [date, setDate] = useState(() => dateInputValue(tomorrow));
  const [time, setTime] = useState(() => timeInputValue(tomorrow));
  const chosen = fromInputs(date, time);
  const valid = chosen !== null && isWithinReminderWindow(chosen, now);

  return (
    <div data-reminder-options={step} className={cn('flex flex-col', NO_TOUCH_SELECT)}>
      {props.preview !== null ? (
        <p
          data-reminder-preview=""
          className="mb-2 truncate rounded-md bg-panel-2 px-3 py-2 text-base text-fg-2"
        >
          {props.preview}
        </p>
      ) : null}
      {step === 'presets' ? (
        <ul className="flex flex-col">
          {presets.map((preset) => (
            <PresetRow
              key={preset.id}
              id={preset.id}
              label={preset.label}
              detail={presetDetail(preset, now)}
              onClick={() =>
                props.onPick(
                  reminderPresets(new Date()).find((p) => p.id === preset.id)?.at ?? preset.at,
                )
              }
            />
          ))}
          <PresetRow id="custom" label="Custom" onClick={() => setStep('custom')} />
          {props.onCancelReminder !== undefined ? (
            <CancelReminderRow onClick={props.onCancelReminder} />
          ) : null}
        </ul>
      ) : (
        <div data-reminder-custom="" className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-sm font-medium text-fg-2">
              Date
              <input
                type="date"
                aria-label="Date"
                value={date}
                min={dateInputValue(now)}
                max={dateInputValue(new Date(now.getTime() + MAX_LEAD_MS))}
                onChange={(event) => setDate(event.target.value)}
                className="h-11 min-w-0 rounded-md border border-border bg-panel-2 px-3 font-mono text-input text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent md:text-base"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-fg-2">
              Time
              <input
                type="time"
                aria-label="Time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
                className="h-11 min-w-0 rounded-md border border-border bg-panel-2 px-3 font-mono text-input text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent md:text-base"
              />
            </label>
          </div>
          <p data-reminder-summary="" className="min-h-5 text-base font-medium text-fg">
            {chosen !== null ? reminderSummary(chosen, now) : ''}
          </p>
          <p className="text-sm text-fg-3">{REMINDER_HELPER}</p>
          <Button
            type="button"
            variant="primary"
            data-reminder-confirm=""
            disabled={!valid}
            onClick={() => {
              if (chosen !== null && isWithinReminderWindow(chosen, new Date()))
                props.onPick(chosen);
            }}
          >
            Set reminder
          </Button>
        </div>
      )}
    </div>
  );
}

function PresetRow(props: {
  id: string;
  label: string;
  detail?: string;
  onClick: () => void;
}): ReactElement {
  return (
    <li>
      <PressableRow
        type="button"
        data-reminder-row={props.id}
        onClick={props.onClick}
        className="flex min-h-[56px] items-center gap-3 px-2 text-fg"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-panel-2 text-fg-2">
          <IconAlarmClock size={ICON_SIZE.control} />
        </span>
        <span className="flex-1 text-lg font-medium">{props.label}</span>
        {props.detail !== undefined ? (
          <span className="font-mono text-sm tabular-nums text-fg-2">{props.detail}</span>
        ) : (
          <IconChevronRight size={ICON_SIZE.inline} className="text-fg-3" />
        )}
      </PressableRow>
    </li>
  );
}

/** Change mode's last row: cancels the pending reminder, in the danger token. */
function CancelReminderRow(props: { onClick: () => void }): ReactElement {
  return (
    <li className="mt-1 border-t border-border pt-1">
      <PressableRow
        type="button"
        data-reminder-row="cancel"
        onClick={props.onClick}
        className="flex min-h-[56px] items-center gap-3 px-2 text-bad hover:bg-bad-soft"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-bad-soft text-bad">
          <IconX size={ICON_SIZE.control} />
        </span>
        <span className="flex-1 text-lg font-medium">{CANCEL_REMINDER_LABEL}</span>
      </PressableRow>
    </li>
  );
}

/**
 * The Remind me sheet (both layouts; the Sheet centres on wide screens). Change
 * mode comes from `change`, else from the reminder target when it is a change.
 */
export function ReminderSheet(props: {
  open: boolean;
  onClose: () => void;
  preview: string | null;
  onPick: (at: Date) => void;
  change?: { onCancelReminder: () => void } | undefined;
}): ReactElement {
  // System Back closes only this sheet; the chat under it stays.
  useHistoryStep(props.open, SHEET_STEP_KEYS.reminder, props.onClose);
  const reminders = useReminderOptional();
  const live =
    props.change ??
    (reminders !== null && reminders.reminderTarget?.mode === 'change'
      ? { onCancelReminder: () => void reminders.cancelReminderFromSheet() }
      : undefined);
  // The mode stays as opened while the sheet slides away (the target clears first).
  const openedAs = useRef(live);
  if (props.open) openedAs.current = live;
  const change = props.open ? live : openedAs.current;
  // A fresh options state (presets step, default custom values) per opening.
  const [openings, setOpenings] = useState(0);
  useEffect(() => {
    if (props.open) setOpenings((n) => n + 1);
  }, [props.open]);
  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title={change !== undefined ? REMINDER_CHANGE_TITLE : REMINDER_SHEET_TITLE}
      footer={
        <>
          <span data-reminder-zone="" className="flex-1 text-sm text-fg-2">
            {zoneLine(new Date())}
          </span>
          <Button type="button" variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <ReminderOptions
        key={openings}
        preview={props.preview}
        onPick={props.onPick}
        onCancelReminder={change?.onCancelReminder}
      />
    </Sheet>
  );
}

/** The chat's reminder sheet, driven by the ReminderProvider (ChatConnected mounts it once). */
export function ChatReminderSheet(): ReactElement | null {
  const reminders = useReminderOptional();
  if (reminders === null) return null;
  return (
    <ReminderSheet
      open={reminders.reminderTarget !== null}
      onClose={reminders.closeReminder}
      preview={reminders.reminderTarget?.preview ?? null}
      onPick={(at) => void reminders.pickReminderTime(at)}
    />
  );
}

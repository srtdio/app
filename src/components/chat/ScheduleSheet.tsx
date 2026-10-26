// The Schedule sheet (phone: the shared Sheet) and the laptop menu (a small
// panel above the Send chevron, anchored right). Both hold the same options:
// "Tomorrow" and "Monday" at 9:00 AM local, and "Custom time" with native date
// and time inputs. Every time is the device's local zone, named in the footer
// from Intl (never hardcoded). Tokens only, so light and dark stay at parity;
// rows are at least 56px with 44px targets. Motion: the Sheet moves on
// translateY only; the menu fades (opacity only).

import { useEffect, useRef, useState } from 'react';
import type { ReactElement, RefObject } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import { ICON_SIZE, IconCalendarClock, IconChevronRight } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import {
  customSummary,
  dateInputValue,
  formatDayTime,
  fromInputs,
  isWithinScheduleWindow,
  MAX_LEAD_MS,
  presetTimes,
  shortZoneName,
  timeInputValue,
} from '@/lib/chat/scheduled';
import { useHistoryStep } from '@/lib/chat/use-history-step';
import { SHEET_STEP_KEYS } from '@/lib/chat/sheet-steps';

const SCHEDULE_SHEET_TITLE = 'Schedule message';
export const SCHEDULE_HELPER = 'Any time from 1 minute to 1 year ahead.';

/** "1 photo", "3 photos", "2 files", "2 photos, 1 file"; '' for none. Pure. */
export function filesLabel(files: { photos: number; others: number }): string {
  const part = (n: number, one: string): string => (n === 1 ? `1 ${one}` : `${n} ${one}s`);
  return [
    files.photos > 0 ? part(files.photos, 'photo') : '',
    files.others > 0 ? part(files.others, 'file') : '',
  ]
    .filter((p) => p !== '')
    .join(', ');
}

/**
 * "To <chat name>: <draft text>", or, for picked files with no text, "To <chat
 * name>: 2 photos"; null without either. Pure.
 */
export function schedulePreview(
  chatName: string,
  draftText: string,
  files: { photos: number; others: number } = { photos: 0, others: 0 },
): string | null {
  const text = draftText.replace(/\s+/g, ' ').trim();
  const shown = text !== '' ? text : filesLabel(files);
  return shown === '' ? null : `To ${chatName}: ${shown}`;
}

/** The footer's zone line. Pure over `now`. */
export function zoneLine(now: Date): string {
  const zone = shortZoneName(now);
  return zone === '' ? 'Times are in your time zone' : `Times are in your time zone (${zone})`;
}

interface OptionsProps {
  preview: string | null;
  onPick: (sendAt: Date) => void;
}

/** The rows and the Custom step; shared by the sheet and the laptop menu. */
export function ScheduleOptions(props: OptionsProps): ReactElement {
  const [step, setStep] = useState<'presets' | 'custom'>('presets');
  const now = new Date();
  const presets = presetTimes(now);
  const [date, setDate] = useState(() => dateInputValue(presets.tomorrow));
  const [time, setTime] = useState(() => timeInputValue(presets.tomorrow));
  const chosen = fromInputs(date, time);
  const valid = chosen !== null && isWithinScheduleWindow(chosen, now);

  return (
    <div data-schedule-options={step} className={cn('flex flex-col', NO_TOUCH_SELECT)}>
      {props.preview !== null ? (
        <p data-schedule-preview="" className="mb-2 truncate px-2 text-base text-fg-2">
          {props.preview}
        </p>
      ) : null}
      {step === 'presets' ? (
        <ul className="flex flex-col">
          <PresetRow
            id="tomorrow"
            label="Tomorrow"
            detail={formatDayTime(presets.tomorrow, now)}
            onClick={() => props.onPick(presets.tomorrow)}
          />
          <PresetRow
            id="monday"
            label="Monday"
            detail={formatDayTime(presets.monday, now)}
            onClick={() => props.onPick(presets.monday)}
          />
          <PresetRow id="custom" label="Custom time" onClick={() => setStep('custom')} />
        </ul>
      ) : (
        <div data-schedule-custom="" className="flex flex-col gap-3">
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
          <p data-schedule-summary="" className="min-h-5 text-base font-medium text-fg">
            {chosen !== null ? customSummary(chosen, now) : ''}
          </p>
          <p className="text-sm text-fg-3">{SCHEDULE_HELPER}</p>
          <Button
            type="button"
            variant="primary"
            disabled={!valid}
            onClick={() => {
              if (chosen !== null && isWithinScheduleWindow(chosen, new Date())) {
                props.onPick(chosen);
              }
            }}
          >
            Schedule
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
        data-schedule-row={props.id}
        onClick={props.onClick}
        className="flex min-h-[56px] items-center gap-3 px-2 text-fg"
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-panel-2 text-fg-2">
          <IconCalendarClock size={ICON_SIZE.control} />
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

function ScheduleFooter(props: { onCancel: () => void }): ReactElement {
  return (
    <>
      <span data-schedule-zone="" className="flex-1 text-sm text-fg-2">
        {zoneLine(new Date())}
      </span>
      <Button type="button" variant="ghost" onClick={props.onCancel}>
        Cancel
      </Button>
    </>
  );
}

/** The phone sheet (also the Time action's picker on both layouts). */
export function ScheduleSheet(props: {
  open: boolean;
  onClose: () => void;
  preview: string | null;
  onPick: (sendAt: Date) => void;
}): ReactElement {
  // A fresh options state (presets step, default custom values) per opening.
  const [openings, setOpenings] = useState(0);
  useEffect(() => {
    if (props.open) setOpenings((n) => n + 1);
  }, [props.open]);
  // System Back closes only this sheet; the chat under it stays.
  useHistoryStep(props.open, SHEET_STEP_KEYS.schedule, props.onClose);
  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title={SCHEDULE_SHEET_TITLE}
      footer={<ScheduleFooter onCancel={props.onClose} />}
    >
      <ScheduleOptions key={openings} preview={props.preview} onPick={props.onPick} />
    </Sheet>
  );
}

/** The laptop menu above the Send chevron, anchored right; opacity only. */
export function ScheduleMenu(props: {
  open: boolean;
  onClose: () => void;
  preview: string | null;
  onPick: (sendAt: Date) => void;
  /** The chevron: a press on it toggles, so it never counts as outside. */
  anchorRef?: RefObject<HTMLElement>;
}): ReactElement | null {
  const [rendered, setRendered] = useState(props.open);
  const rootRef = useRef<HTMLDivElement>(null);
  const anchorRef = props.anchorRef;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (props.open) {
      setRendered(true);
      const raf = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const timer = setTimeout(() => setRendered(false), 150);
    return () => clearTimeout(timer);
  }, [props.open]);
  const onClose = props.onClose;
  useEffect(() => {
    if (!props.open) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
      // Focus goes back to the chevron that opened it.
      anchorRef?.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    }
    function onPointer(event: Event): void {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) === true) return;
      if (anchorRef?.current?.contains(target) === true) return;
      onClose();
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [props.open, onClose, anchorRef]);
  if (!rendered) return null;
  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={SCHEDULE_SHEET_TITLE}
      data-schedule-menu=""
      className={cn(
        'absolute bottom-full right-3 z-30 mb-2 flex w-[340px] max-w-[calc(100%-24px)] flex-col rounded-lg border border-border-strong bg-panel shadow-2xl transition-opacity duration-[150ms] ease-out motion-reduce:transition-none',
        shown ? 'opacity-100' : 'opacity-0',
      )}
    >
      <h2 className="px-4 pb-1 pt-3 text-lg font-semibold text-fg">{SCHEDULE_SHEET_TITLE}</h2>
      <div className="px-2 pb-2">
        <ScheduleOptions preview={props.preview} onPick={props.onPick} />
      </div>
      <div className="flex items-center gap-2 border-t border-border px-4 py-1">
        <ScheduleFooter onCancel={props.onClose} />
      </div>
    </div>
  );
}

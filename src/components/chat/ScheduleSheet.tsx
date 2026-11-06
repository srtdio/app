// The Schedule sheet (phone: the shared Sheet) and the laptop menu (a small
// panel above the Send chevron, anchored right). Both hold the same options:
// "Tomorrow" and "Monday" at 9:00 AM local, and "Custom time" with native date
// and time inputs. Every time is the device's local zone, named in the footer
// from Intl (never hardcoded). Tokens only, so light and dark stay at parity;
// rows are at least 56px with 44px targets. Motion: the Sheet rises; the menu
// grows from the Send chevron and shrinks back to it (growFromTrigger, never a
// fade).

import { useEffect, useState } from 'react';
import type { ReactElement, RefObject } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { IconCalendarClock } from '@/components/ui/icons';
import { WhenOptions } from '@/components/chat/WhenOptions';
import { textRole } from '@/components/ui/Text';
import {
  customSummary,
  formatDayTime,
  isWithinScheduleWindow,
  presetTimes,
  shortZoneName,
} from '@/lib/chat/scheduled';
import { useHistoryStep } from '@/lib/chat/use-history-step';
import { SHEET_STEP_KEYS } from '@/lib/chat/sheet-steps';
import { usePresence } from '@/lib/motion';
import { useMenuKeys } from '@/lib/useMenuKeys';
import { centreOf, menuMoves } from '@/components/ui/popover-classes';

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

/**
 * The rows and the Custom step; shared by the sheet and the laptop menu. The
 * frame is the one chat time pick (WhenOptions), shared with Remind me.
 */
export function ScheduleOptions(props: OptionsProps): ReactElement {
  const now = new Date();
  const presets = presetTimes(now);
  return (
    <WhenOptions
      hook="schedule"
      preview={
        props.preview !== null ? (
          <p data-schedule-preview="" className="mb-2 truncate px-2 text-base text-fg-2">
            {props.preview}
          </p>
        ) : null
      }
      icon={IconCalendarClock}
      menuLabel={SCHEDULE_SHEET_TITLE}
      presets={[
        {
          id: 'tomorrow',
          label: 'Tomorrow',
          detail: formatDayTime(presets.tomorrow, now),
          onPick: () => props.onPick(presets.tomorrow),
        },
        {
          id: 'monday',
          label: 'Monday',
          detail: formatDayTime(presets.monday, now),
          onPick: () => props.onPick(presets.monday),
        },
      ]}
      customLabel="Custom time"
      custom={{
        initial: presets.tomorrow,
        summary: customSummary,
        allowed: isWithinScheduleWindow,
        helper: SCHEDULE_HELPER,
        confirmLabel: 'Schedule',
        onPick: props.onPick,
      }}
    />
  );
}

/**
 * The zone line, plus Cancel on the laptop menu only. The phone sheet has no
 * footer Cancel: the X in its header closes it.
 */
export function ScheduleFooter(props: { onCancel?: (() => void) | undefined }): ReactElement {
  return (
    <>
      <span data-schedule-zone="" className="flex-1 text-sm text-fg-2">
        {zoneLine(new Date())}
      </span>
      {props.onCancel !== undefined ? (
        <Button type="button" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      ) : null}
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
      footer={<ScheduleFooter />}
    >
      <ScheduleOptions key={openings} preview={props.preview} onPick={props.onPick} />
    </Sheet>
  );
}

/** The laptop menu above the Send chevron, anchored right; grows from the chevron. */
export function ScheduleMenu(props: {
  open: boolean;
  onClose: () => void;
  preview: string | null;
  onPick: (sendAt: Date) => void;
  /** The chevron: a press on it toggles, so it never counts as outside. */
  anchorRef?: RefObject<HTMLElement>;
}): ReactElement | null {
  const anchorRef = props.anchorRef;
  const { rendered, ref: rootRef } = usePresence<HTMLDivElement>(
    props.open,
    menuMoves(() => centreOf(anchorRef?.current), 'right'),
  );
  const onClose = props.onClose;
  // The first preset takes focus on open; the arrows move between presets.
  const keys = useMenuKeys(rootRef, props.open);
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
      onKeyDown={keys.onKeyDown}
      data-schedule-menu=""
      className="absolute bottom-full right-3 z-30 mb-2 flex w-[340px] max-w-[calc(100%-24px)] flex-col rounded-xl border bg-panel lit-overlay"
    >
      <h2 className={textRole('heading', 'px-4 pb-1 pt-3 text-fg')}>{SCHEDULE_SHEET_TITLE}</h2>
      <div className="px-2 pb-2">
        <ScheduleOptions preview={props.preview} onPick={props.onPick} />
      </div>
      <div className="flex items-center gap-2 border-t border-border px-4 py-1">
        <ScheduleFooter onCancel={props.onClose} />
      </div>
    </div>
  );
}

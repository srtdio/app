// "Scheduled in this chat": one card per scheduled row, soonest first. Each
// card has the calendar-clock and the send time (mono), its photos and files
// (ScheduledAttachments: up to four thumbnails, files by icon and name), the
// message in the own-bubble style, and four equal 44px actions: Send now, Edit
// (text only, in place; files stay read-only), Time (the Schedule sheet) and
// Cancel (a confirm sheet). The writes
// and their errors are the caller's; this only collects the user's intent.
// Tokens only; sheets move on translateY only.

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import { Textarea } from '@/components/ui/Textarea';
import { ICON_SIZE, IconCalendarClock } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { BUBBLE_SHAPE, BUBBLE_TAIL, NO_TOUCH_SELECT } from '@/components/chat/chat-type';
import { ScheduleSheet } from '@/components/chat/ScheduleSheet';
import { restoreDraftText } from '@/components/chat/Composer';
import {
  resolveMentionText,
  serializeMentions,
  type MentionPick,
  type NameOf,
} from '@/lib/chat/mentions';
import {
  formatSendLabel,
  SCHEDULED_FILES_READONLY_COPY,
  type ScheduledRow,
} from '@/lib/chat/scheduled';
import { ScheduledAttachments } from '@/components/chat/ScheduledStrip';

export const SCHEDULED_LIST_TITLE = 'Scheduled in this chat';
/** FN23: the card's action reads "Don't send", so the message is never confused with a dismiss. */
export const CANCEL_CONFIRM_TITLE = "Don't send this message?";
export const DONT_SEND_LABEL = "Don't send";

/** A card's preview: the body (names shown), else what it carries. Pure. */
export function scheduledPreviewText(row: ScheduledRow, nameOf: NameOf): string {
  const body = (row.body ?? '').trim();
  if (body !== '') return resolveMentionText(body, nameOf);
  if ((row.attachment_asset_ids ?? []).length > 0) return 'Attachment';
  if ((row.shared_brief_ids ?? []).length > 0 && (row.shared_post_ids ?? []).length === 0) {
    return 'Shared brief';
  }
  return 'Shared post';
}

/** Whether a row carries photos or files. Pure. */
export function rowHasAttachments(row: Pick<ScheduledRow, 'attachment_asset_ids'>): boolean {
  return (row.attachment_asset_ids ?? []).length > 0;
}

/**
 * Whether a card shows the text bubble: a body, or nothing else to show (a
 * shared post or brief label). Photos and files alone show only their
 * thumbnails. Pure.
 */
export function showsPreviewBubble(row: ScheduledRow): boolean {
  return (row.body ?? '').trim() !== '' || !rowHasAttachments(row);
}

/** Edit is offered for a row with text, or with files (a caption can be added). Pure. */
export function canEditScheduled(row: ScheduledRow): boolean {
  return (row.body ?? '').trim() !== '' || rowHasAttachments(row);
}

export interface ScheduledListActions {
  onSendNow: (row: ScheduledRow) => Promise<void>;
  /** Save a new body (serialized, tokens kept) at the row's current time. */
  onSaveBody: (row: ScheduledRow, body: string) => Promise<boolean>;
  /** Move the row to a new time, body and mentions unchanged. */
  onRetime: (row: ScheduledRow, sendAt: Date) => Promise<boolean>;
  onCancel: (row: ScheduledRow) => Promise<boolean>;
}

export function ScheduledListSheet(
  props: {
    open: boolean;
    onClose: () => void;
    rows: readonly ScheduledRow[];
    nameOf: NameOf;
  } & ScheduledListActions,
): ReactElement {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [timeFor, setTimeFor] = useState<ScheduledRow | null>(null);
  const [cancelFor, setCancelFor] = useState<ScheduledRow | null>(null);

  // Closing (or a row leaving the list) drops any edit in progress.
  useEffect(() => {
    if (!props.open) setEditingId(null);
  }, [props.open]);

  async function run(row: ScheduledRow, action: () => Promise<unknown>): Promise<void> {
    if (busyId !== null) return;
    setBusyId(row.id);
    try {
      await action();
    } finally {
      setBusyId(null);
    }
  }

  const now = new Date();
  return (
    <>
      <Sheet open={props.open} onClose={props.onClose} title={SCHEDULED_LIST_TITLE}>
        <ul data-scheduled-list="" className="flex flex-col gap-3">
          {props.rows.map((row) => (
            <li
              key={row.id}
              data-scheduled-card={row.id}
              className="flex flex-col gap-2 rounded-lg border border-border bg-panel-2 p-3"
            >
              <div className={cn('flex items-center gap-2 text-fg-2', NO_TOUCH_SELECT)}>
                <IconCalendarClock size={ICON_SIZE.inline} className="text-accent" />
                <span className="font-mono text-sm tabular-nums">
                  {formatSendLabel(new Date(row.send_at), now)}
                </span>
              </div>
              {editingId === row.id ? (
                <BodyEditor
                  row={row}
                  nameOf={props.nameOf}
                  busy={busyId === row.id}
                  onDone={() => setEditingId(null)}
                  onSave={(body) =>
                    run(row, async () => {
                      if (await props.onSaveBody(row, body)) setEditingId(null);
                    })
                  }
                />
              ) : (
                <>
                  <ScheduledAttachments row={row} size="card" />
                  {showsPreviewBubble(row) ? (
                    <div className="flex justify-end">
                      <p
                        data-scheduled-preview=""
                        className={cn(
                          'max-w-[85%] whitespace-pre-wrap break-words bg-bubble-own px-3 py-2 text-lg leading-snug text-accent-fg',
                          BUBBLE_SHAPE.touch,
                          BUBBLE_TAIL.mine,
                        )}
                      >
                        {scheduledPreviewText(row, props.nameOf)}
                      </p>
                    </div>
                  ) : null}
                  <div className={cn('grid grid-cols-4 gap-2', NO_TOUCH_SELECT)}>
                    <CardAction
                      tone="primary"
                      disabled={busyId !== null}
                      onClick={() => void run(row, () => props.onSendNow(row))}
                    >
                      Send now
                    </CardAction>
                    <CardAction
                      disabled={busyId !== null || !canEditScheduled(row)}
                      onClick={() => setEditingId(row.id)}
                    >
                      Edit
                    </CardAction>
                    <CardAction disabled={busyId !== null} onClick={() => setTimeFor(row)}>
                      Time
                    </CardAction>
                    <CardAction
                      tone="danger"
                      disabled={busyId !== null}
                      onClick={() => setCancelFor(row)}
                    >
                      {DONT_SEND_LABEL}
                    </CardAction>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      </Sheet>

      <ScheduleSheet
        open={timeFor !== null}
        onClose={() => setTimeFor(null)}
        preview={null}
        onPick={(sendAt) => {
          const row = timeFor;
          setTimeFor(null);
          if (row !== null) void run(row, () => props.onRetime(row, sendAt));
        }}
      />

      <Sheet
        open={cancelFor !== null}
        onClose={() => setCancelFor(null)}
        title={CANCEL_CONFIRM_TITLE}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setCancelFor(null)}>
              Keep
            </Button>
            <Button
              type="button"
              variant="danger"
              data-cancel-scheduled=""
              disabled={busyId !== null}
              onClick={() => {
                const row = cancelFor;
                setCancelFor(null);
                if (row !== null) void run(row, () => props.onCancel(row));
              }}
            >
              {DONT_SEND_LABEL}
            </Button>
          </div>
        }
      >
        <p className="truncate text-base text-fg-2">
          {cancelFor !== null ? scheduledPreviewText(cancelFor, props.nameOf) : ''}
        </p>
      </Sheet>
    </>
  );
}

const CARD_ACTION_TONE = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
  plain: 'border border-border bg-panel text-fg hover:bg-panel-3',
  danger: 'border border-border bg-panel text-bad hover:bg-bad-soft',
} as const;

/** One of a card's four equal 44px actions. */
function CardAction(props: {
  tone?: keyof typeof CARD_ACTION_TONE;
  disabled: boolean;
  onClick: () => void;
  children: string;
}): ReactElement {
  return (
    <PressableRow
      type="button"
      align="center"
      data-card-action={props.children}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        'inline-flex h-11 min-w-0 items-center justify-center whitespace-nowrap px-1 text-md font-medium transition-colors duration-fast',
        CARD_ACTION_TONE[props.tone ?? 'plain'],
      )}
    >
      {props.children}
    </PressableRow>
  );
}

/**
 * Edit a scheduled body in place: mentions stay tokens underneath and show as
 * "@Name", the way the composer shows them. Photos and files are read-only
 * here (chat_scheduled_update keeps them): they show above the text with a
 * line saying how to change them. With files the text may go empty.
 */
export function BodyEditor(props: {
  row: ScheduledRow;
  nameOf: NameOf;
  busy: boolean;
  onDone: () => void;
  onSave: (body: string) => void;
}): ReactElement {
  const [initial] = useState(() => {
    const body = props.row.body ?? '';
    return restoreDraftText({ text: body, caret: body.length }, props.nameOf);
  });
  const [text, setText] = useState(initial.text);
  const [picks] = useState<MentionPick[]>(initial.picks);
  const body = serializeMentions(text, picks);
  const hasFiles = rowHasAttachments(props.row);
  return (
    <div data-scheduled-editor="" className="flex flex-col gap-2">
      {hasFiles ? (
        <div data-scheduled-files-readonly="" className="flex flex-col gap-1.5">
          <ScheduledAttachments row={props.row} size="card" />
          <p className="text-sm text-fg-3">{SCHEDULED_FILES_READONLY_COPY}</p>
        </div>
      ) : null}
      <Textarea
        aria-label="Message"
        value={text}
        autoGrow
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={props.onDone}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={props.busy || (body.trim() === '' && !hasFiles)}
          onClick={() => props.onSave(body)}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

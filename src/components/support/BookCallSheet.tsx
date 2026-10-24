// "Book a call": three suggested slots from the rule in book-call-slots.ts, or
// any day and time the viewer types, in their own time zone. Book POSTs to the
// book-call-send edge function (Bearer + apikey + X-Trace-Id); the function
// emails the team, who send a Google Meet link. A failure stays inline and Book
// comes back.

import { useEffect, useMemo, useState } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { IconCheck } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import {
  chosenInstant,
  slotLabel,
  suggestedSlots,
  tomorrowInputValue,
  viewerTimeZone,
  type CallChoice,
} from './book-call-slots';

export interface BookCallSheetProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
}

const SEND_FAILED = "Couldn't send. Try again.";

/** 15 minutes, in seconds, for the time input. */
const TIME_STEP_SECONDS = 15 * 60;

function functionUrl(): string {
  return `${env.VITE_SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/book-call-send`;
}

/** POST the booking. true only on a 2xx; never throws. */
async function sendBookCall(input: {
  workspaceId: string;
  slotAt: Date;
  timeZone: string;
  traceId: string;
}): Promise<boolean> {
  try {
    const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
    if (token === null || token === '') return false;
    const res = await fetchWithTrace(
      functionUrl(),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          workspace_id: input.workspaceId,
          slot_at: input.slotAt.toISOString(),
          tz: input.timeZone,
        }),
      },
      input.traceId,
    );
    return res.ok;
  } catch (err: unknown) {
    logger.warn('book-call-send failed', { error: String(err) });
    return false;
  }
}

function ChoiceRow(props: { label: string; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      onClick={props.onSelect}
      className={cn(
        'flex min-h-[44px] w-full items-center gap-3 rounded-lg border px-3 text-left text-base font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        props.selected
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-border text-fg hover:bg-panel-2',
      )}
    >
      <span className="min-w-0 flex-1 break-words">{props.label}</span>
      {props.selected ? <IconCheck size={18} className="shrink-0" /> : null}
    </button>
  );
}

export function BookCallSheet({ open, onClose, workspaceId }: BookCallSheetProps) {
  const newTrace = useNewTrace();
  const [now, setNow] = useState(() => new Date());
  const [choice, setChoice] = useState<CallChoice>(null);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [booked, setBooked] = useState<string | null>(null);

  // A fresh open starts over, with slots counted from this moment.
  useEffect(() => {
    if (!open) return;
    setNow(new Date());
    setChoice(null);
    setDate('');
    setTime('');
    setSending(false);
    setFailed(false);
    setBooked(null);
  }, [open]);

  const timeZone = useMemo(() => viewerTimeZone(), []);
  const slots = useMemo(() => suggestedSlots(now, timeZone), [now, timeZone]);
  const minDate = useMemo(() => tomorrowInputValue(now, timeZone), [now, timeZone]);
  const slotAt = chosenInstant({ choice, slots, date, time, minDate, timeZone });

  async function book(): Promise<void> {
    if (slotAt === null) return;
    setSending(true);
    setFailed(false);
    try {
      const ok = await sendBookCall({ workspaceId, slotAt, timeZone, traceId: newTrace() });
      if (ok) setBooked(slotLabel(slotAt, timeZone));
      else setFailed(true);
    } finally {
      setSending(false);
    }
  }

  if (booked !== null) {
    return (
      <Sheet
        open={open}
        onClose={onClose}
        title="Booked"
        footer={
          <Button variant="primary" className="ml-auto" onClick={onClose}>
            Done
          </Button>
        }
      >
        <p className="text-base leading-relaxed text-fg-2">
          {booked}. The team sends a Google Meet link to your email before the call.
        </p>
      </Sheet>
    );
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Book a call"
      footer={
        <Button
          variant="primary"
          className="ml-auto"
          disabled={slotAt === null || sending}
          onClick={() => void book()}
        >
          Book
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-base leading-relaxed text-fg-2">
          Pick a time. We send a Google Meet link to your email.
        </p>
        <div role="radiogroup" aria-label="Book a call" className="flex flex-col gap-2">
          {slots.map((slot, index) => (
            <ChoiceRow
              key={slot.at.toISOString()}
              label={slot.label}
              selected={choice?.kind === 'slot' && choice.index === index}
              onSelect={() => setChoice({ kind: 'slot', index })}
            />
          ))}
          <ChoiceRow
            label="Another day or time"
            selected={choice?.kind === 'other'}
            onSelect={() => setChoice({ kind: 'other' })}
          />
        </div>
        {choice?.kind === 'other' ? (
          <div className="flex flex-col gap-1.5">
            <div className="grid grid-cols-2 gap-2">
              <Input
                type="date"
                aria-label="Date"
                min={minDate}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
              <Input
                type="time"
                aria-label="Time"
                step={TIME_STEP_SECONDS}
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
            <p className="text-xs text-fg-3">Your time zone. We confirm by email.</p>
          </div>
        ) : null}
        {failed ? (
          <p role="alert" className="text-base text-bad">
            {SEND_FAILED}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}

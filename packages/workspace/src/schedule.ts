// Workspace-timezone send-window gate for invite email.
//
// Standing answer (PR 8): email is only handed to Resend between 9am and 9pm in
// the workspace's own timezone (workspaces.timezone). Outside that window the
// send is queued to the next 9am local, and the later bundler (PR 20) flushes
// it. We compute the local wall clock with Intl rather than a TZ library so the
// package stays dependency-free.

export const SEND_WINDOW_START_HOUR = 9;
export const SEND_WINDOW_END_HOUR = 21;

export interface InviteSendSchedule {
  /** True when the workspace-local time is inside the 9am-9pm window. */
  sendNow: boolean;
  /** ISO instant to send: now when sendNow, otherwise the next local 9am. */
  scheduledFor: string;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  // Intl renders midnight as hour 24 under hour12:false; normalize to 0.
  const hour = out.hour === 24 ? 0 : (out.hour ?? 0);
  return {
    year: out.year ?? 0,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

// Milliseconds to add to a UTC instant to read the same wall clock in timeZone.
function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (date.getTime() - date.getMilliseconds());
}

// The UTC instant matching a wall-clock time in timeZone. A single correction
// pass is exact except within a sub-second DST seam, which 9am never lands on.
function wallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  const offset = zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess - offset);
}

export function inviteSendSchedule(timeZone: string, now: Date): InviteSendSchedule {
  const local = zonedParts(now, timeZone);
  if (local.hour >= SEND_WINDOW_START_HOUR && local.hour < SEND_WINDOW_END_HOUR) {
    return { sendNow: true, scheduledFor: now.toISOString() };
  }

  let { year, month, day } = local;
  if (local.hour >= SEND_WINDOW_END_HOUR) {
    // After the window closes: roll to the next calendar day in the workspace TZ.
    const tomorrow = new Date(Date.UTC(year, month - 1, day) + 24 * 60 * 60 * 1000);
    year = tomorrow.getUTCFullYear();
    month = tomorrow.getUTCMonth() + 1;
    day = tomorrow.getUTCDate();
  }
  const target = wallClockToUtc(year, month, day, SEND_WINDOW_START_HOUR, timeZone);
  return { sendNow: false, scheduledFor: target.toISOString() };
}

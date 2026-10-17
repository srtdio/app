import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import { BackHome, SiteShell, Tick } from './Chrome';
import { DEMO, type DemoSlot } from './config';
import {
  DEMO_BOOKED_HEADING,
  DEMO_FIELDS,
  DEMO_SEND_ERROR,
  GRID_CELLS,
  WEEK_HEADERS,
  addDays,
  bookingSummary,
  demoBookedLine,
  isBookable,
  isoDay,
  longDate,
  mobileDigits,
  monthGrid,
  monthRange,
  monthTitle,
  sameDay,
  shiftMonth,
  todayIn,
  validateDemo,
  type CalendarDay,
  type DemoField,
  type DemoForm,
} from './demo';
import './home.css';

// /demo: Book a demo. A valid submit posts to the demo-request-send edge
// function, which mails the request to the team; on { ok } the form gives way
// to the Booked state.

const POINTS = [
  'Your first client workspace, ready to use',
  'How your client approves a post',
  'Moving a WhatsApp group over, step by step',
] as const;

const DEMO_FUNCTION = 'demo-request-send';

/** The body demo-request-send reads; `website` is the honeypot, empty for people. */
interface DemoRequestBody {
  name: string;
  email: string;
  mobile: string;
  day: string;
  slot: DemoSlot;
  website: string;
}

/** True when the function answered { ok: true }; any other outcome is a failed send. */
async function sendDemoRequest(body: DemoRequestBody): Promise<boolean> {
  try {
    // Loaded on submit, never with the page: fetch.ts and env.ts pull in Sentry
    // and zod, which the home bundle keeps off first paint.
    const [{ fetchWithTrace }, { env }] = await Promise.all([
      import('@/lib/fetch'),
      import('@/lib/env'),
    ]);
    const res = await fetchWithTrace(
      `${env.VITE_SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/${DEMO_FUNCTION}`,
      {
        method: 'POST',
        headers: {
          apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) return false;
    const data: unknown = await res.json();
    return typeof data === 'object' && data !== null && (data as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

// The honeypot sits off screen and out of the tab order; people never fill it.
const HONEYPOT: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
};

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (message === undefined) return null;
  return (
    <p className="err" id={id}>
      {message}
    </p>
  );
}

// The page is prerendered at build time (scripts/prerender.ts) and hydrated, so
// nothing date-dependent may be in the first render: the month, its days and
// the arrows fill in after mount. The grid always holds six week rows (42
// cells) so its height never depends on the month or on mounting: empty
// placeholders before mount, then the month with the adjacent months' days.
const FILLER: CSSProperties = { minHeight: 44 };
const HIDDEN: CSSProperties = { visibility: 'hidden' };

function Calendar({
  today,
  value,
  onPick,
  invalid,
  gridRef,
}: {
  today: CalendarDay;
  value: CalendarDay | null;
  onPick: (day: CalendarDay) => void;
  invalid: boolean;
  gridRef: RefObject<HTMLDivElement>;
}) {
  const range = useMemo(() => monthRange(today), [today]);
  const firstBookable = useMemo(() => {
    let day = addDays(today, DEMO.firstDay);
    while (!isBookable(day, today)) day = addDays(day, 1);
    return day;
  }, [today]);
  const [month, setMonth] = useState<CalendarDay>({ y: firstBookable.y, m: firstBookable.m, d: 1 });
  const atFirst = sameDay(month, range.first);
  const atLast = sameDay(month, range.last);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const cells = mounted ? monthGrid(month) : [];
  const fillers = mounted ? [] : Array.from({ length: GRID_CELLS }, (_, i) => i);
  return (
    <div
      className="cal"
      role="group"
      aria-label="Pick a day"
      aria-describedby={invalid ? 'demo-day-err' : undefined}
    >
      <div className="cal-head">
        <button
          type="button"
          className="icon-btn"
          aria-label="Previous month"
          disabled={!mounted || atFirst}
          style={mounted ? undefined : HIDDEN}
          onClick={() => setMonth((m) => shiftMonth(m, -1))}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <span className="cal-title" aria-live="polite">
          {mounted ? monthTitle(month) : '\u00a0'}
        </span>
        <button
          type="button"
          className="icon-btn"
          aria-label="Next month"
          disabled={!mounted || atLast}
          style={mounted ? undefined : HIDDEN}
          onClick={() => setMonth((m) => shiftMonth(m, 1))}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
      <div className="cal-grid" ref={gridRef}>
        {WEEK_HEADERS.map((name) => (
          <span key={name} className="cal-wd" aria-hidden="true">
            {name}
          </span>
        ))}
        {cells.map(({ day, outside }) =>
          outside ? (
            <span key={`${day.m}-${day.d}`} className="cal-out" aria-hidden="true">
              {day.d}
            </span>
          ) : (
            <button
              key={day.d}
              type="button"
              className="cal-day"
              data-day={`${day.y}-${day.m}-${day.d}`}
              disabled={!isBookable(day, today)}
              aria-pressed={value !== null && sameDay(day, value)}
              aria-current={sameDay(day, today) ? 'date' : undefined}
              aria-label={longDate(day)}
              onClick={() => onPick(day)}
            >
              {day.d}
            </button>
          ),
        )}
        {fillers.map((i) => (
          <span key={`fill-${i}`} className="cal-pad" aria-hidden="true" style={FILLER} />
        ))}
      </div>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
    </div>
  );
}

export default function DemoPage() {
  const [today] = useState(() => todayIn(new Date()));
  const [form, setForm] = useState<DemoForm>({
    name: '',
    email: '',
    mobile: '',
    day: null,
    slot: null,
  });
  const [website, setWebsite] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [booked, setBooked] = useState<{ day: CalendarDay; slot: DemoSlot } | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const mobileRef = useRef<HTMLInputElement>(null);
  const dayGridRef = useRef<HTMLDivElement>(null);
  const slotsRef = useRef<HTMLDivElement>(null);
  const bookedRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (booked !== null) bookedRef.current?.focus();
  }, [booked]);

  const errors = submitted ? validateDemo(form) : {};
  const update = (patch: Partial<DemoForm>): void => setForm((prev) => ({ ...prev, ...patch }));

  const focusField = (field: DemoField): void => {
    if (field === 'name') nameRef.current?.focus();
    else if (field === 'email') emailRef.current?.focus();
    else if (field === 'mobile') mobileRef.current?.focus();
    else if (field === 'day')
      dayGridRef.current?.querySelector<HTMLButtonElement>('.cal-day:not(:disabled)')?.focus();
    else slotsRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (sending) return;
    setSubmitted(true);
    setFailed(false);
    const found = validateDemo(form);
    const first = DEMO_FIELDS.find((field) => found[field] !== undefined);
    const { day, slot } = form;
    if (first !== undefined || day === null || slot === null) {
      if (first !== undefined) focusField(first);
      return;
    }
    setSending(true);
    try {
      const ok = await sendDemoRequest({
        name: form.name.trim(),
        email: form.email.trim(),
        mobile: form.mobile,
        day: isoDay(day),
        slot,
        website,
      });
      if (ok) setBooked({ day, slot });
      else setFailed(true);
    } finally {
      setSending(false);
    }
  };

  const described = (field: DemoField): string | undefined =>
    errors[field] !== undefined ? `demo-${field}-err` : undefined;

  return (
    <SiteShell surface="demo">
      <section className="page demo">
        <div className="wrap">
          <BackHome />
          <div className="demo-grid">
            <div className="demo-intro">
              <h1 className="d">See it with your own client work.</h1>
              <p>
                A 30 minute call. We set up one of your clients in Sorted while you watch, then hand
                it over.
              </p>
              <ul className="points">
                {POINTS.map((point) => (
                  <li key={point}>
                    <Tick />
                    {point}
                  </li>
                ))}
              </ul>
            </div>

            {booked !== null ? (
              <div className="demo-form" data-demo-booked="">
                <h2 className="d" ref={bookedRef} tabIndex={-1}>
                  {DEMO_BOOKED_HEADING}
                </h2>
                <p className="notice">{demoBookedLine(booked.day, booked.slot)}</p>
                <a className="btn" href="/">
                  Back to home
                </a>
              </div>
            ) : (
              <form
                className="demo-form"
                noValidate
                onSubmit={(event) => {
                  void onSubmit(event);
                }}
              >
                <Field label="Name" htmlFor="demo-name">
                  <input
                    ref={nameRef}
                    id="demo-name"
                    type="text"
                    autoComplete="name"
                    value={form.name}
                    aria-invalid={errors.name !== undefined}
                    aria-describedby={described('name')}
                    onChange={(e) => update({ name: e.target.value })}
                  />
                  <FieldError id="demo-name-err" message={errors.name} />
                </Field>

                <Field label="Work email" htmlFor="demo-email">
                  <input
                    ref={emailRef}
                    id="demo-email"
                    type="email"
                    autoComplete="email"
                    value={form.email}
                    aria-invalid={errors.email !== undefined}
                    aria-describedby={described('email')}
                    onChange={(e) => update({ email: e.target.value })}
                  />
                  <FieldError id="demo-email-err" message={errors.email} />
                </Field>

                <Field label="Mobile" htmlFor="demo-mobile">
                  <div className="tel">
                    <span className="cc" aria-hidden="true">
                      +91
                    </span>
                    <input
                      ref={mobileRef}
                      id="demo-mobile"
                      type="tel"
                      inputMode="numeric"
                      autoComplete="tel-national"
                      maxLength={10}
                      value={form.mobile}
                      aria-label="Mobile, +91"
                      aria-invalid={errors.mobile !== undefined}
                      aria-describedby={described('mobile')}
                      onChange={(e) => update({ mobile: mobileDigits(e.target.value) })}
                    />
                  </div>
                  <FieldError id="demo-mobile-err" message={errors.mobile} />
                </Field>

                <div className="field">
                  <Calendar
                    today={today}
                    value={form.day}
                    invalid={errors.day !== undefined}
                    gridRef={dayGridRef}
                    onPick={(day) => update({ day })}
                  />
                  <FieldError id="demo-day-err" message={errors.day} />
                </div>

                <div className="field" role="group" aria-labelledby="demo-slot-label">
                  <p className="slot-label" id="demo-slot-label">
                    Pick a time ({DEMO.timeZoneLabel}, {DEMO.durationLabel})
                  </p>
                  {form.day === null ? (
                    <p className="hint">Choose a day first. Weekdays only.</p>
                  ) : (
                    <div className="slots" ref={slotsRef}>
                      {DEMO.slots.map((slot: DemoSlot) => (
                        <button
                          key={slot}
                          type="button"
                          className="slot"
                          aria-pressed={form.slot === slot}
                          aria-describedby={described('slot')}
                          onClick={() => update({ slot })}
                        >
                          {slot}
                        </button>
                      ))}
                    </div>
                  )}
                  <FieldError id="demo-slot-err" message={errors.slot} />
                </div>

                {form.day !== null && form.slot !== null ? (
                  <p className="summary" data-demo-summary="">
                    {bookingSummary(form.day, form.slot)}
                  </p>
                ) : null}

                <input
                  style={HONEYPOT}
                  type="text"
                  name="website"
                  aria-hidden="true"
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />

                <button className="btn" type="submit" disabled={sending}>
                  Book my demo
                </button>
                {failed ? (
                  <p className="err" role="alert">
                    {DEMO_SEND_ERROR}
                  </p>
                ) : null}
              </form>
            )}
          </div>
        </div>
      </section>
    </SiteShell>
  );
}

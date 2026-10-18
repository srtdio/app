// The guide's pieces, presentational only: the amber hairline around the one
// real control (its outer shadow is the soft dim), the hand that presses it,
// the label pill beside it, the green result tick, the guide bar, and the
// intro and closing cards.
// None of the overlay pieces takes a pointer; the guard in InductionGuide
// decides which taps reach the app. Colours are tokens only (light and dark).

import { forwardRef, type ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { DOCK_GAP, type Rect } from '@/lib/induction';
import { CHROME_ATTR } from './guide-dom';

/** Above page content and Sheet (z-50); below toasts (z-60/70) and the lightbox (z-80). */
export const GUIDE_Z = 'z-[55]';

/** The six guide tokens (src/index.css): amber fill and ink, the deep fill, the light tint, two triplets. */
const AMBER_BG = 'bg-[var(--guide)]';
const AMBER_INK = 'text-[var(--guide-ink)]';
const AMBER_DEEP_BG = 'bg-[var(--guide-deep)]';
const AMBER_LIGHT_BG = 'bg-[var(--guide-light)]';
const LABEL_EDGE = 'border border-[rgb(var(--guide-ink-rgb)/0.12)]';
const LABEL_GLOW = 'shadow-[0_2px_8px_rgb(var(--guide-rgb)/0.35)]';

/** Keyframes for the hand, its ripple and the nudge; reduced motion holds them still. */
const GUIDE_STYLE = `
@keyframes sorted-guide-press {
  0%, 40%, 100% { transform: translate(0, 0) scale(1); }
  10%, 30% { transform: translate(1px, 2px) scale(0.9); }
  20% { transform: translate(0, 0) scale(1); }
}
@keyframes sorted-guide-ripple {
  0% { transform: scale(0.3); opacity: 0; }
  10% { transform: scale(0.4); opacity: 0.9; }
  45% { transform: scale(1.5); opacity: 0; }
  100% { transform: scale(1.5); opacity: 0; }
}
@keyframes sorted-guide-nudge {
  0%, 100% { translate: 0 0; }
  25% { translate: -5px 0; }
  75% { translate: 5px 0; }
}
[data-guide-hand-svg] { transform-origin: 17px 1px; animation: sorted-guide-press 1.3s ease-in-out infinite; }
[data-guide-ripple] { animation: sorted-guide-ripple 1.3s ease-out infinite; }
[data-guide-nudge="on"] { animation: sorted-guide-nudge 300ms ease-in-out; }
@media (prefers-reduced-motion: reduce) {
  [data-guide-hand-svg] { animation: none; }
  [data-guide-ripple] { animation: none; transform: scale(0.8); opacity: 0.9; }
  [data-guide-nudge="on"] { animation: none; }
}
`;

export function GuideStyle(): ReactElement {
  return <style>{GUIDE_STYLE}</style>;
}

/**
 * The hairline, placed in page coordinates (absolute, the live rect plus the
 * page scroll), not fixed: when the iOS keyboard opens, Safari pans the page
 * under fixed elements and a fixed box drifts off its control. Its huge outer
 * shadow is the dim, so the control's own hole stays clear.
 */
/**
 * The dim alone, with no cut-out: held while the next control slides or scrolls
 * into place, so the screen never flashes bright between two dimmed steps.
 */
export function GuideDim(): ReactElement {
  return (
    <div
      data-induction-dim=""
      aria-hidden="true"
      className={`pointer-events-none fixed inset-0 ${GUIDE_Z} bg-[rgba(14,16,30,0.30)] dark:bg-[rgba(0,0,0,0.22)]`}
    />
  );
}

export function GuideBox({ rect, radius }: { rect: Rect; radius: number }): ReactElement {
  return (
    <div
      data-induction-box=""
      aria-hidden="true"
      className={`pointer-events-none absolute ${GUIDE_Z} border border-[var(--guide)] shadow-[0_0_0_200vmax_rgba(14,16,30,0.30)] dark:shadow-[0_0_0_200vmax_rgba(0,0,0,0.22)]`}
      style={{
        top: rect.top + window.scrollY,
        left: rect.left + window.scrollX,
        width: rect.width,
        height: rect.height,
        borderRadius: radius,
      }}
    />
  );
}

/** The fingertip's spot inside the 40px hand. */
export const HAND_TIP = { x: 17, y: 1 };
const HAND_SIZE = 40;
const RIPPLE = 28;

/** The hand pressing the control twice, then resting, with a thin light ring from its tip. */
export function GuideHand({
  tip,
  nudge,
}: {
  tip: { x: number; y: number };
  nudge: number;
}): ReactElement {
  return (
    <div
      key={nudge}
      data-induction-hand=""
      data-guide-nudge={nudge > 0 ? 'on' : 'off'}
      aria-hidden="true"
      className={`pointer-events-none absolute ${GUIDE_Z}`}
      style={{
        top: tip.y - HAND_TIP.y + window.scrollY,
        left: tip.x - HAND_TIP.x + window.scrollX,
        width: HAND_SIZE,
        height: HAND_SIZE,
      }}
    >
      <span
        data-guide-ripple=""
        className="absolute rounded-full border-2 border-[var(--overlay-fg)]"
        style={{
          width: RIPPLE,
          height: RIPPLE,
          top: HAND_TIP.y - RIPPLE / 2,
          left: HAND_TIP.x - RIPPLE / 2,
        }}
      />
      <svg
        data-guide-hand-svg=""
        width={HAND_SIZE}
        height={HAND_SIZE}
        viewBox="0 0 40 40"
        className="relative drop-shadow-md"
      >
        <path
          d="M14 4a3 3 0 0 1 6 0v12a3 3 0 0 1 6 0v2a3 3 0 0 1 6 0v2a3 3 0 0 1 5 2v8c0 6-4 9-10 9h-4c-4 0-6-2-8-5l-6-8a3 3 0 0 1 5-4l0 0z"
          fill="var(--panel)"
          stroke="var(--fg)"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

/** The amber label pill beside the control. */
export const GuideLabel = forwardRef<
  HTMLDivElement,
  { text: string; at: { top: number; left: number }; nudge: number }
>(function GuideLabel({ text, at, nudge }, ref) {
  return (
    <div
      ref={ref}
      key={nudge}
      data-induction-label=""
      data-guide-nudge={nudge > 0 ? 'on' : 'off'}
      className={`pointer-events-none fixed ${GUIDE_Z} max-w-[min(280px,calc(100vw-32px))] rounded-full px-3 py-1.5 text-[14px] font-[650] leading-tight ${LABEL_EDGE} ${LABEL_GLOW} ${AMBER_BG} ${AMBER_INK}`}
      style={{ top: at.top, left: at.left }}
    >
      {text}
    </div>
  );
});

export interface BarCopy {
  /** "Step 3" on setup steps; '' on look-around steps. */
  phase: string;
  /** Look-around steps: the chapters in order, the current one named. */
  chapters: { names: readonly string[]; current: number };
  why: string;
  legend: string;
  back: string;
  later: string;
  /** The pause's button: "Next". */
  next: string;
  aria: { bar: string; progress: string; back: string };
}

export interface BarActions {
  /** undefined hides Back. */
  onBack: (() => void) | undefined;
  /** undefined hides the optional step's secondary chip. */
  onLater: (() => void) | undefined;
  /** A pause before the next screen: Next takes them on. undefined hides it. */
  onNext?: (() => void) | undefined;
}

export interface DockAt {
  side: 'top' | 'bottom';
  laptop: boolean;
  /** Space the dock keeps clear: the safe area top, and the tab bar plus safe area bottom. */
  insets: { top: number; bottom: number };
}

function dockStyle(dock: DockAt): { className: string; style: Record<string, number> } {
  const vertical =
    dock.side === 'top'
      ? { top: dock.insets.top + DOCK_GAP }
      : { bottom: dock.insets.bottom + DOCK_GAP };
  if (dock.laptop) return { className: 'right-4 w-[340px]', style: vertical };
  return { className: 'left-2 right-2', style: vertical };
}

const CHIP =
  'flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full px-3 text-[13px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

export const GuideBar = forwardRef<
  HTMLElement,
  { copy: BarCopy; actions: BarActions; progress: number; dock: DockAt }
>(function GuideBar({ copy, actions, progress, dock }, ref) {
  const placed = dockStyle(dock);
  return (
    <section
      ref={ref}
      {...{ [CHROME_ATTR]: '' }}
      data-induction-bar={dock.side}
      aria-label={copy.aria.bar}
      aria-live="polite"
      className={`fixed ${GUIDE_Z} ${placed.className} overflow-hidden rounded-xl border border-border-strong bg-panel text-fg shadow-2xl`}
      style={placed.style}
    >
      <div
        role="progressbar"
        aria-label={copy.aria.progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        className={`h-1 w-full ${AMBER_LIGHT_BG}`}
      >
        <div
          data-induction-progress=""
          className={`h-full ${AMBER_DEEP_BG}`}
          style={{ width: `${Math.round(progress * 1000) / 10}%` }}
        />
      </div>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <div className="min-w-0 flex-1">
          <PhaseRow copy={copy} />
          {copy.why !== '' ? (
            <p className="text-[13px] leading-snug text-fg [text-wrap:pretty]">{copy.why}</p>
          ) : null}
          {copy.legend !== '' ? (
            <p data-induction-legend="" className="mt-0.5 text-[12px] leading-snug text-fg-2">
              {copy.legend}
            </p>
          ) : null}
        </div>
        <BarButtons copy={copy} actions={actions} />
      </div>
    </section>
  );
});

function PhaseRow({ copy }: { copy: BarCopy }): ReactElement {
  if (copy.phase !== '') {
    return <p className="font-mono text-[11px] text-fg-3">{copy.phase}</p>;
  }
  const { names, current } = copy.chapters;
  return (
    <p className="flex items-center gap-1.5 text-[11px] text-fg-3">
      {names.map((name, i) => (
        <span
          key={name}
          aria-hidden="true"
          data-induction-chapter={i === current ? 'current' : i < current ? 'done' : 'upcoming'}
          className={`h-1.5 w-1.5 rounded-full ${i === current ? AMBER_BG : i < current ? 'bg-good' : 'bg-border-strong'}`}
        />
      ))}
      <span className="font-semibold text-fg-2">{names[current] ?? ''}</span>
    </p>
  );
}

function BarButtons({ copy, actions }: { copy: BarCopy; actions: BarActions }): ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {actions.onNext !== undefined ? (
        <button
          type="button"
          data-induction-next=""
          onClick={actions.onNext}
          className={`${CHIP} ${AMBER_BG} ${AMBER_INK} px-4`}
        >
          {copy.next}
        </button>
      ) : null}
      {actions.onLater !== undefined ? (
        <button type="button" onClick={actions.onLater} className={`${CHIP} bg-panel-2 text-fg`}>
          {copy.later}
        </button>
      ) : null}
      {actions.onBack !== undefined ? (
        <button
          type="button"
          data-induction-back=""
          aria-label={copy.aria.back}
          onClick={actions.onBack}
          className={`${CHIP} text-fg-2`}
        >
          {copy.back}
        </button>
      ) : null}
    </div>
  );
}

export interface CardCopy {
  eyebrow: string;
  title: string;
  body: string;
  pills: readonly string[];
  button: string;
  /** The clear card's two figures (things done, time taken). */
  stats?: readonly { value: string; label: string }[];
}

/** The intro (hero, indigo, chapter pills, Start) or closing (plain, Done) card, docked like the bar. */
export function GuideCard({
  kind,
  copy,
  onPress,
  dock,
}: {
  kind: 'intro' | 'closing' | 'clear';
  copy: CardCopy;
  onPress: () => void;
  dock: DockAt;
}): ReactElement {
  const placed = dockStyle(dock);
  const hero = kind === 'intro';
  return (
    <section
      {...{ [CHROME_ATTR]: '' }}
      data-induction-card={kind}
      aria-label={copy.title}
      aria-live="polite"
      className={`fixed ${GUIDE_Z} ${placed.className} rounded-xl p-4 shadow-2xl ${hero ? 'bg-accent text-accent-fg' : 'border border-border-strong bg-panel text-fg'}`}
      style={placed.style}
    >
      {copy.eyebrow !== '' ? (
        <p className={`font-mono text-[11px] ${hero ? 'opacity-80' : 'text-fg-3'}`}>
          {copy.eyebrow}
        </p>
      ) : null}
      <p className="mt-1 text-[17px] font-semibold leading-snug [text-wrap:balance]">
        {copy.title}
      </p>
      <p
        className={`mt-1 text-[13px] leading-snug [text-wrap:pretty] ${hero ? 'opacity-90' : 'text-fg-2'}`}
      >
        {copy.body}
      </p>
      {copy.stats !== undefined && copy.stats.length > 0 ? (
        <div className="mt-3 flex gap-3">
          {copy.stats.map((stat) => (
            <div key={stat.label} className="flex-1 rounded-lg bg-panel-2 px-3 py-2.5">
              <p className="text-[20px] font-semibold tabular-nums text-accent">{stat.value}</p>
              <p className="text-[12px] text-fg-2">{stat.label}</p>
            </div>
          ))}
        </div>
      ) : null}
      {copy.pills.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {copy.pills.map((pill) => (
            <span
              key={pill}
              className="rounded-full bg-[var(--overlay-surface)] px-2.5 py-1 text-[12px] font-semibold"
            >
              {pill}
            </span>
          ))}
        </div>
      ) : null}
      <div className="mt-3 flex justify-end">
        <Button
          variant={hero ? 'default' : 'primary'}
          size="lg"
          onClick={onPress}
          className={hero ? 'border-transparent bg-panel text-fg hover:bg-panel-2' : ''}
        >
          {copy.button}
        </Button>
      </div>
    </section>
  );
}

// The guide's pieces, presentational only: the amber hairline around the one
// real control (its outer shadow is the soft dim), the hand that presses it,
// the label pill beside it, the green result tick, the guide bar, and the
// intro and closing cards.
// None of the overlay pieces takes a pointer; the guard in InductionGuide
// decides which taps reach the app. Colours are tokens only (light and dark).
//
// Motion (docs/motion.md): everything renders at its rest pose first. The hand
// presses twice and its ring grows out and settles (handPress, handRipple:
// finite, scale only, never a fade); a tap away nudges the hand and label on X
// (guideNudge); the bar and the closing cards slide on X between steps
// (stepX: Next +1, Back -1). All instant under Reduce Motion or ?motion=0, and
// any tap finishes them. The spotlight keeps its token (no move).

import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
  type ForwardedRef,
  type ReactElement,
} from 'react';
import { Button } from '@/components/ui/Button';
import { IconHand } from '@/components/ui/icons';
import { DOCK_GAP, type Rect } from '@/lib/induction';
import { MOVE_CLASS, stepX } from '@/lib/motion';
import { GUIDE_RIPPLE_REST_SCALE, guideNudge, handPress, handRipple } from '@/lib/motion/touches';
import { CHROME_ATTR } from './guide-dom';

/** Above page content and Sheet (z-50); below toasts (z-60/70) and the lightbox (z-80). */
const GUIDE_Z = 'z-[55]';

/**
 * The guide tokens (src/index.css): amber fill and ink, the deep fill, the light
 * tint, two triplets. They have no Tailwind colour names, so they read their CSS
 * variable directly. The label pill floats with lit-float (one light above).
 */
const AMBER_BG = 'bg-[var(--guide)]';
const AMBER_INK = 'text-[var(--guide-ink)]';
const AMBER_DEEP_BG = 'bg-[var(--guide-deep)]';
const LABEL_EDGE = 'border border-[rgb(var(--guide-ink-rgb)/0.12)]';

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
      className={`pointer-events-none fixed inset-0 ${GUIDE_Z} bg-[var(--guide-dim)]`}
    />
  );
}

export function GuideBox({ rect, radius }: { rect: Rect; radius: number }): ReactElement {
  return (
    <div
      data-induction-box=""
      aria-hidden="true"
      className={`pointer-events-none absolute ${GUIDE_Z} border border-[var(--guide)] shadow-[var(--shadow-spotlight)]`}
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
const HAND_TIP = { x: 17, y: 1 };
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
  // A new nudge remounts the hand (key), so it nudges and presses again.
  return <GuideHandAt key={nudge} tip={tip} nudge={nudge} />;
}

function GuideHandAt({
  tip,
  nudge,
}: {
  tip: { x: number; y: number };
  nudge: number;
}): ReactElement {
  const hand = useRef<HTMLDivElement>(null);
  const ripple = useRef<HTMLSpanElement>(null);
  const svg = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (nudge > 0) guideNudge(hand.current);
    handPress(svg.current, `${HAND_TIP.x}px ${HAND_TIP.y}px`);
    handRipple(ripple.current);
    // Mount only: a new nudge is a new mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      ref={hand}
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
        ref={ripple}
        data-guide-ripple=""
        className="absolute rounded-full border-2 border-overlay-fg"
        style={{
          width: RIPPLE,
          height: RIPPLE,
          top: HAND_TIP.y - RIPPLE / 2,
          left: HAND_TIP.x - RIPPLE / 2,
          transform: `scale(${GUIDE_RIPPLE_REST_SCALE})`,
        }}
      />
      <span ref={svg} data-guide-hand-svg="" className="relative block text-fg">
        <IconHand size={HAND_SIZE} />
      </span>
    </div>
  );
}

/** Sets both a local ref and a forwarded one. */
function useBothRefs<T>(local: { current: T | null }, forwarded: ForwardedRef<T>) {
  return useCallback(
    (node: T | null) => {
      local.current = node;
      if (typeof forwarded === 'function') forwarded(node);
      else if (forwarded !== null) forwarded.current = node;
    },
    [local, forwarded],
  );
}

/** The amber label pill beside the control. A new nudge wiggles it on X. */
export const GuideLabel = forwardRef<
  HTMLDivElement,
  { text: string; at: { top: number; left: number }; nudge: number }
>(function GuideLabel({ text, at, nudge }, ref) {
  const local = useRef<HTMLDivElement | null>(null);
  const setRef = useBothRefs(local, ref);
  useLayoutEffect(() => {
    if (nudge > 0) guideNudge(local.current);
  }, [nudge]);
  return (
    <div
      ref={setRef}
      data-induction-label=""
      data-guide-nudge={nudge > 0 ? 'on' : 'off'}
      className={`pointer-events-none fixed ${GUIDE_Z} max-w-[min(280px,calc(100vw-32px))] rounded-full px-3 py-1.5 text-base font-semibold leading-tight ${LABEL_EDGE} lit-float ${AMBER_BG} ${AMBER_INK}`}
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
  back: string;
  later: string;
  /** The pause's button: "Next". */
  next: string;
  /** "Skip tour". */
  skip: string;
  aria: { bar: string; progress: string; back: string };
}

interface BarActions {
  /** undefined hides Back. */
  onBack: (() => void) | undefined;
  /** undefined hides the optional step's secondary chip. */
  onLater: (() => void) | undefined;
  /** A pause before the next screen: Next takes them on. undefined hides it. */
  onNext?: (() => void) | undefined;
  /** Skip tour: ends the tour. undefined hides it. */
  onSkip?: (() => void) | undefined;
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
  // On the page edge (L2): 16 phone, 24 laptop.
  if (dock.laptop) return { className: 'right-6 w-[340px]', style: vertical };
  return { className: 'left-4 right-4', style: vertical };
}

/** Layout added to every guide control (each is a <Button>: 44 tall, 8px radius, 14 / 500). */
const GUIDE_ACTION = 'min-w-[44px] shrink-0';

export const GuideBar = forwardRef<
  HTMLElement,
  {
    copy: BarCopy;
    actions: BarActions;
    progress: number;
    dock: DockAt;
    /** The step's place in the tour; a change slides the bar on X (Next +1, Back -1). */
    stepIndex?: number;
  }
>(function GuideBar({ copy, actions, progress, dock, stepIndex }, ref) {
  const placed = dockStyle(dock);
  const local = useRef<HTMLElement | null>(null);
  const setRef = useBothRefs(local, ref);
  const shownStep = useRef(stepIndex);
  useLayoutEffect(() => {
    const before = shownStep.current;
    shownStep.current = stepIndex;
    if (before === undefined || stepIndex === undefined || before === stepIndex) return;
    stepX(local.current, stepIndex > before ? 1 : -1);
  }, [stepIndex]);
  return (
    <section
      ref={setRef}
      {...{ [CHROME_ATTR]: '' }}
      data-induction-bar={dock.side}
      aria-label={copy.aria.bar}
      aria-live="polite"
      className={`fixed ${GUIDE_Z} ${placed.className} overflow-hidden rounded-xl border bg-panel text-fg lit-overlay`}
      style={placed.style}
    >
      <div
        role="progressbar"
        aria-label={copy.aria.progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        className="h-1 w-full bg-panel-3 lit-well lit-track"
      >
        <div
          data-induction-progress=""
          className={`h-full ${AMBER_DEEP_BG} lit-fill ${MOVE_CLASS.fill}`}
          style={{ width: `${Math.round(progress * 1000) / 10}%` }}
        />
      </div>
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <PhaseRow copy={copy} />
          {copy.why !== '' ? (
            <p className="text-base leading-snug text-fg [text-wrap:pretty]">{copy.why}</p>
          ) : null}
        </div>
        <BarButtons copy={copy} actions={actions} />
      </div>
    </section>
  );
});

function PhaseRow({ copy }: { copy: BarCopy }): ReactElement {
  if (copy.phase !== '') {
    return <p className="font-mono text-sm text-fg-3">{copy.phase}</p>;
  }
  const { names, current } = copy.chapters;
  return (
    <p className="flex items-center gap-1.5 text-sm text-fg-3">
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
        <Button
          type="button"
          variant="primary"
          data-induction-next=""
          onClick={actions.onNext}
          className={GUIDE_ACTION}
        >
          {copy.next}
        </Button>
      ) : null}
      {actions.onLater !== undefined ? (
        <Button
          type="button"
          variant="secondary"
          onClick={actions.onLater}
          className={GUIDE_ACTION}
        >
          {copy.later}
        </Button>
      ) : null}
      {actions.onBack !== undefined ? (
        <Button
          type="button"
          variant="ghost"
          data-induction-back=""
          aria-label={copy.aria.back}
          onClick={actions.onBack}
          className={GUIDE_ACTION}
        >
          {copy.back}
        </Button>
      ) : null}
      {actions.onSkip !== undefined ? (
        <Button
          type="button"
          variant="ghost"
          data-induction-skip=""
          onClick={actions.onSkip}
          className={GUIDE_ACTION}
        >
          {copy.skip}
        </Button>
      ) : null}
    </div>
  );
}

interface CardCopy {
  eyebrow: string;
  title: string;
  body: string;
  pills: readonly string[];
  button: string;
  /** The clear card's two figures (things done, time taken). */
  stats?: readonly { value: string; label: string }[];
  /** The intro's "Skip tour", shown with onSkip. */
  skip?: string;
}

/** The intro (chapter pills, Start) or closing (Done) card on the panel, docked like the bar. */
export function GuideCard({
  kind,
  copy,
  onPress,
  onSkip,
  dock,
  busy = false,
}: {
  kind: 'intro' | 'closing' | 'clear';
  copy: CardCopy;
  onPress: () => void;
  /** The press is running (the clear card): Button busy, the label kept. */
  busy?: boolean;
  /** Skip tour beside the button; undefined hides it. */
  onSkip?: (() => void) | undefined;
  dock: DockAt;
}): ReactElement {
  const placed = dockStyle(dock);
  // The intro is the step card's role (sheet/dialog: 16, lit-overlay); the
  // closing and clear cards keep the popover radius.
  const shape = kind === 'intro' ? 'rounded-2xl' : 'rounded-xl';
  // The closing and clear cards come after the last step: they slide in on X
  // like a Next. The intro is the tour's first paint and does not move.
  const card = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (kind !== 'intro') stepX(card.current, 1);
  }, [kind]);
  return (
    <section
      ref={card}
      {...{ [CHROME_ATTR]: '' }}
      data-induction-card={kind}
      aria-label={copy.title}
      aria-live="polite"
      className={`fixed ${GUIDE_Z} ${placed.className} ${shape} border bg-panel p-4 text-fg lit-overlay`}
      style={placed.style}
    >
      {copy.eyebrow !== '' ? <p className="font-mono text-sm text-fg-3">{copy.eyebrow}</p> : null}
      <p className="mt-1 text-base font-medium [text-wrap:balance]">{copy.title}</p>
      <p className="mt-1 text-base leading-snug text-fg-2 [text-wrap:pretty]">{copy.body}</p>
      {copy.stats !== undefined && copy.stats.length > 0 ? (
        <div className="mt-3 flex gap-3">
          {copy.stats.map((stat) => (
            <div
              key={stat.label}
              className="flex-1 rounded-xl border bg-panel-2 px-3 py-2 lit-card-muted"
            >
              <p className="text-2xl font-semibold tabular-nums text-accent">{stat.value}</p>
              <p className="text-sm text-fg-2">{stat.label}</p>
            </div>
          ))}
        </div>
      ) : null}
      {copy.pills.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {copy.pills.map((pill) => (
            <span
              key={pill}
              className="rounded-full bg-panel-2 px-3 py-1 text-sm font-semibold text-fg-2 lit-pill"
            >
              {pill}
            </span>
          ))}
        </div>
      ) : null}
      <div className="mt-3 flex items-center justify-end gap-2">
        {onSkip !== undefined && copy.skip !== undefined ? (
          <Button
            type="button"
            variant="ghost"
            data-induction-skip=""
            onClick={onSkip}
            className={GUIDE_ACTION}
          >
            {copy.skip}
          </Button>
        ) : null}
        <Button variant="primary" busy={busy} onClick={onPress}>
          {copy.button}
        </Button>
      </div>
    </section>
  );
}

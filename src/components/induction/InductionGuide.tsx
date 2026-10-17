// The guide layer on top of the real app. On a step: a soft dim with the one
// real control left clear inside a thin amber hairline, a hand pressing it, a
// label pill beside it, and the guide bar (progress, phase or chapter, the why
// line, Back, Skip). Only the control takes taps; the step finishes by the tap,
// the DOM or the data and the guide moves on by itself. While the app moves
// (route change, a sheet sliding in, the control not found yet) only the bar
// shows. The intro and closing cards dock where the bar does.
//
// The control is found by its data-induction key and its rect is read live in
// every render; useLiveTick re-renders whenever it could have moved. A new step
// opens its screen, and leaving a gate's screen brings the person back to it.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  backIndex,
  barSide,
  boxRect,
  chapterOrder,
  clampToViewport,
  completesByUi,
  DOCK_GAP,
  guideRadius,
  handPoint,
  onPlace,
  placeLabel,
  placeRoute,
  progressOf,
  skipTarget,
  type Rect,
  type Resolution,
  type StepProbe,
} from '@/lib/induction';
import { fillCopy, GUIDE_CHROME, GUIDE_LEGEND } from '@/lib/induction-copy';
import type { RouteScript, Step } from '@/lib/induction-model';
import { LAPTOP_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { useInduction, type InductionContextValue } from './InductionProvider';
import {
  GuideBar,
  GuideBox,
  GuideCard,
  GuideHand,
  GuideLabel,
  GuideStyle,
  type BarCopy,
  type DockAt,
} from './GuideParts';
import { findVisible, formOf, LAYER_ATTR, radiusOf, rectOf, textFieldOf } from './guide-dom';
import {
  useAbsentSkip,
  useElementSize,
  useLegend,
  useStepCompletion,
  useTapGuard,
} from './guide-hooks';
import { useLiveTick } from './useLiveTick';

const PHONE_TAB_BAR = 56;

type StepResolution = Extract<Resolution, { kind: 'step' }>;
type CardResolution = Extract<Resolution, { kind: 'intro' | 'closing' }>;

export function InductionGuide({ tabsShown }: { tabsShown: boolean }): ReactElement | null {
  const ctx = useInduction();
  if (ctx === null || ctx.resolution.kind === 'off' || ctx.script === undefined) return null;
  return <ActiveGuide ctx={ctx} script={ctx.script} tabsShown={tabsShown} />;
}

function ActiveGuide({
  ctx,
  script,
  tabsShown,
}: {
  ctx: InductionContextValue;
  script: RouteScript;
  tabsShown: boolean;
}): ReactElement | null {
  const laptop = useMediaQuery(LAPTOP_QUERY);
  useStepNavigation(ctx);
  const safeTop = useRef<HTMLDivElement>(null);
  const safeBottom = useRef<HTMLDivElement>(null);
  const insets = {
    top: safeTop.current?.offsetHeight ?? 0,
    bottom: (safeBottom.current?.offsetHeight ?? 0) + (tabsShown && !laptop ? PHONE_TAB_BAR : 0),
  };
  const { resolution } = ctx;
  if (resolution.kind === 'off') return null;
  return createPortal(
    <div {...{ [LAYER_ATTR]: '' }} data-induction-step={stepIdOf(resolution)}>
      <GuideStyle />
      <div
        ref={safeTop}
        aria-hidden="true"
        className="pointer-events-none invisible fixed left-0 top-0 h-[env(safe-area-inset-top)] w-0"
      />
      <div
        ref={safeBottom}
        aria-hidden="true"
        className="pointer-events-none invisible fixed bottom-0 left-0 h-[env(safe-area-inset-bottom)] w-0"
      />
      {resolution.kind === 'step' ? (
        <StepLayer ctx={ctx} script={script} resolution={resolution} frame={{ laptop, insets }} />
      ) : (
        <CardLayer ctx={ctx} resolution={resolution} dock={{ side: 'bottom', laptop, insets }} />
      )}
    </div>,
    document.body,
  );
}

function stepIdOf(resolution: Exclude<Resolution, { kind: 'off' }>): string {
  if (resolution.kind === 'step') return resolution.step.id;
  return resolution.card.id;
}

/**
 * A new step opens its screen, and keeps opening it until the person has been
 * on it once (a tapped control's own navigation can land after the step
 * changed). After that the person's own moves win, except on a gate, whose
 * screen cannot be left.
 */
function useStepNavigation(ctx: InductionContextValue): void {
  const navigate = useNavigate();
  const location = useLocation();
  const { resolution, place } = ctx;
  const step = resolution.kind === 'step' ? resolution.step : undefined;
  const opened = useRef({ id: '', arrived: false, navigated: false });

  useEffect(() => {
    if (step === undefined) return;
    if (opened.current.id !== step.id) {
      opened.current = { id: step.id, arrived: false, navigated: false };
    }
    const now = opened.current;
    if (onPlace(step.place, location, place)) {
      now.arrived = true;
      return;
    }
    if (now.arrived && step.kind !== 'gate') return;
    navigate(placeRoute(step.place, place), { replace: now.navigated });
    now.navigated = true;
  }, [step, location, place, navigate]);
}

function CardLayer({
  ctx,
  resolution,
  dock,
}: {
  ctx: InductionContextValue;
  resolution: CardResolution;
  dock: DockAt;
}): ReactElement {
  const { card } = resolution;
  const fill = (text: string): string => fillCopy(text, ctx.copy);
  return (
    <GuideCard
      kind={card.kind}
      copy={{
        eyebrow: fill(card.eyebrow ?? ''),
        title: fill(card.title),
        body: fill(card.body),
        pills: card.pills ?? [],
        button: card.button,
      }}
      onPress={card.kind === 'intro' ? ctx.start : ctx.finish}
      dock={dock}
    />
  );
}

interface Frame {
  laptop: boolean;
  insets: { top: number; bottom: number };
}

/** The live probe the pure rules read: is a step's control on screen, did the data finish it. */
function probeOf(ctx: InductionContextValue): StepProbe {
  return {
    visible: (step: Step) => findVisible(step.targets, ctx.qualifiers).found,
    done: ctx.isDone,
  };
}

function StepLayer({
  ctx,
  script,
  resolution,
  frame,
}: {
  ctx: InductionContextValue;
  script: RouteScript;
  resolution: StepResolution;
  frame: Frame;
}): ReactElement {
  const { step, steps, index } = resolution;
  const probe = probeOf(ctx);
  const [barEl, setBarEl] = useState<HTMLElement | null>(null);
  const bar = useElementSize(barEl, BAR_FALLBACK);
  // A control covered by a modal that does not hold it counts as not on screen.
  const target = findVisible(step.targets, ctx.qualifiers);
  const el = target.found ? target.el : undefined;
  const moving = useLiveTick(el);
  useBringIntoView(step.id, el);
  const next = steps[index + 1];
  const nextFound = next !== undefined ? findVisible(next.targets, ctx.qualifiers) : undefined;
  const nextEl = nextFound?.found === true ? nextFound.el : undefined;

  const boxed = el !== undefined && !moving ? el : undefined;
  const field = el !== undefined ? textFieldOf(el) : undefined;

  const location = useLocation();
  useStepCompletion(
    {
      stepKey: step.id,
      enabled: completesByUi(steps, index),
      el,
      nextEl,
      nextElsewhere: next === undefined || next.place !== step.place,
      where: `${location.pathname}${location.search}`,
    },
    () => ctx.moveTo(index + 1),
  );
  useAbsentSkip({ stepKey: step.id, found: el !== undefined }, () => {
    if (ctx.isDone(step)) return;
    const to = skipTarget(steps, index, probe);
    if (to !== index) ctx.moveTo(to);
  });
  const nudge = useTapGuard(boxed, {
    next: field !== undefined ? nextEl : undefined,
    form: boxed !== undefined ? formOf(boxed, step.kind === 'gate') : undefined,
  });
  const legend = useLegend(script.route, step.id);

  const control = boxed !== undefined ? rectOf(boxed) : undefined;
  const back = index === 0 ? -1 : backIndex(steps, index, probe);
  const order = chapterOrder(steps);
  const copy: BarCopy = {
    phase: step.phase ?? '',
    chapters: {
      names: order.map((chapter) => GUIDE_CHROME.chapters[chapter]),
      current: step.chapter !== undefined ? order.indexOf(step.chapter) : -1,
    },
    why: fillCopy(step.why, ctx.copy),
    legend: legend ? GUIDE_LEGEND : '',
    back: GUIDE_CHROME.back,
    skip: GUIDE_CHROME.skip,
    later: step.laterLabel ?? '',
    aria: {
      bar: GUIDE_CHROME.barAria,
      progress: GUIDE_CHROME.progressAria,
      back: GUIDE_CHROME.backAria,
      skip: GUIDE_CHROME.skipAria,
    },
  };
  const dock: DockAt = {
    side: barSide(control !== undefined ? boxRect(control) : undefined, {
      viewportHeight: window.innerHeight,
      insets: frame.insets,
      barHeight: bar.height,
    }),
    laptop: frame.laptop,
    insets: frame.insets,
  };
  return (
    <>
      {control !== undefined && boxed !== undefined ? (
        <Spotlight
          control={control}
          radius={guideRadius(radiusOf(boxed))}
          label={fillCopy(step.label, ctx.copy)}
          frame={{ dock, nudge, barHeight: bar.height }}
        />
      ) : null}
      <GuideBar
        ref={setBarEl}
        copy={copy}
        progress={progressOf(script, resolution)}
        dock={dock}
        actions={{
          onBack: back >= 0 ? () => ctx.moveTo(back) : undefined,
          onSkip: ctx.finish,
          onLater:
            step.kind === 'optional' && step.laterLabel !== undefined
              ? () => ctx.moveTo(index + 1)
              : undefined,
        }}
      />
    </>
  );
}

const BAR_FALLBACK = { width: 0, height: 72 };
const LABEL_FALLBACK = { width: 180, height: 32 };

function Spotlight({
  control,
  radius,
  label,
  frame,
}: {
  control: Rect;
  radius: number;
  label: string;
  frame: { dock: DockAt; nudge: number; barHeight: number };
}): ReactElement {
  const [labelEl, setLabelEl] = useState<HTMLDivElement | null>(null);
  const size = useElementSize(labelEl, LABEL_FALLBACK);
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const box = boxRect(control);
  const { dock } = frame;
  const barRoom = dock.laptop ? 0 : frame.barHeight + DOCK_GAP;
  const area = {
    top: dock.insets.top + (dock.side === 'top' ? barRoom : 0),
    bottom: viewport.height - (dock.side === 'bottom' ? dock.insets.bottom + barRoom : 0),
    width: viewport.width,
    viewportHeight: viewport.height,
  };
  const at = placeLabel({ box, label: size, area });
  return (
    <>
      <GuideBox rect={clampToViewport(box, viewport)} radius={radius} />
      <GuideHand tip={handPoint(control)} nudge={frame.nudge} />
      <GuideLabel ref={setLabelEl} text={label} at={at} nudge={frame.nudge} />
    </>
  );
}

/** How long after a step starts the guide keeps its control in view (a thread re-sticking to its bottom). */
const BRING_WINDOW_MS = 1500;

/**
 * When a step starts, scroll its control into view if it sits off screen, and
 * keep doing so for a moment while the page settles. After that the person's
 * own scrolling wins. Instant, so reduced motion holds.
 */
function useBringIntoView(stepId: string, el: HTMLElement | undefined): void {
  const since = useRef({ key: '', at: 0 });
  useEffect(() => {
    if (el === undefined) return;
    const key = `${stepId}:${el.getAttribute('data-induction') ?? ''}`;
    if (since.current.key !== key) since.current = { key, at: performance.now() };
    if (performance.now() - since.current.at > BRING_WINDOW_MS) return;
    const r = el.getBoundingClientRect();
    if (r.top >= 0 && r.bottom <= window.innerHeight) return;
    el.scrollIntoView?.({ block: 'center' });
  });
}

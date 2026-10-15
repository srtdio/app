// The guide layer on top of the real app: an accent box around the one control
// that matters and a small card that never covers it (or, inside an open sheet
// or dialog, a one-line strip under its title). The control is found by its
// data-induction key and its rect is read live in every render; useLiveTick
// re-renders on resize, scroll, the control's own size, DOM changes and while a
// sheet slides. Nothing positional is stored.
//
// It also keeps the person on track: a new step opens its screen, and leaving
// a hard gate's screen brings them back to it.

import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  boxRadius,
  boxRect,
  clampToViewport,
  onPlace,
  placeCard,
  placeRoute,
  stepButtons,
  stepCopy,
  stepCountLabel,
  stripRect,
  type InductionResolution,
  type Rect,
} from '@/lib/induction';
import { useMediaQuery } from '@/lib/use-media-query';
import { useInduction, type InductionContextValue } from './InductionProvider';
import { GuideBox, GuideCard, GuideStrip, type GuideCopy } from './GuideParts';
import { dialogTitleRect, findTarget, LAYER_ATTR, radiusOf, rectOf, topDialog } from './guide-dom';
import { useLiveTick } from './useLiveTick';

const LAPTOP_QUERY = '(min-width: 768px)';
const CARD_WIDTH = 320;
const PHONE_TAB_BAR = 56;

export function InductionGuide({ tabsShown }: { tabsShown: boolean }): ReactElement | null {
  const ctx = useInduction();
  if (ctx === null || ctx.resolution.kind === 'off') return null;
  return <ActiveGuide ctx={ctx} tabsShown={tabsShown} />;
}

function ActiveGuide({
  ctx,
  tabsShown,
}: {
  ctx: InductionContextValue;
  tabsShown: boolean;
}): ReactElement | null {
  const { resolution } = ctx;
  useStepNavigation(ctx);
  useFinishAtEnd(resolution, ctx.finish);
  if (resolution.kind !== 'step') return null;
  return <GuideLayer ctx={ctx} resolution={resolution} tabsShown={tabsShown} />;
}

/** A new step opens its screen; a hard gate's screen cannot be left. */
function useStepNavigation(ctx: InductionContextValue): void {
  const navigate = useNavigate();
  const location = useLocation();
  const { resolution, place } = ctx;
  const step = resolution.kind === 'step' ? resolution.step : null;
  const stepId = step?.id ?? '';
  const opened = useRef('');

  useEffect(() => {
    if (step === null) return;
    const here = onPlace(step.place, location, place);
    const firstTime = opened.current !== stepId;
    opened.current = stepId;
    if (here) return;
    if (firstTime || step.kind === 'gate') {
      navigate(placeRoute(step.place, place), { replace: !firstTime });
    }
  }, [step, stepId, location, place, navigate]);
}

/** Past the last step (or every remaining step done by the data): stamp it done once. */
function useFinishAtEnd(resolution: InductionResolution, finish: () => void): void {
  const done = useRef(false);
  useEffect(() => {
    if (resolution.kind !== 'finish' || done.current) return;
    done.current = true;
    finish();
  }, [resolution, finish]);
}

function GuideLayer({
  ctx,
  resolution,
  tabsShown,
}: {
  ctx: InductionContextValue;
  resolution: Extract<InductionResolution, { kind: 'step' }>;
  tabsShown: boolean;
}): ReactElement {
  const laptop = useMediaQuery(LAPTOP_QUERY);
  const { step } = resolution;
  const target = findTarget(step.targets);
  const el = target.found ? target.el : undefined;
  useLiveTick(el);
  useBringIntoView(step.id, el);

  const safeTop = useRef<HTMLDivElement>(null);
  const safeBottom = useRef<HTMLDivElement>(null);
  // The card's own height (its copy wraps), so the placement can keep it clear of the box.
  const [cardEl, setCardEl] = useState<HTMLElement | null>(null);
  const [cardHeight, setCardHeight] = useState(140);
  useLayoutEffect(() => {
    if (cardEl === null) return;
    const measure = (): void => {
      if (cardEl.offsetHeight > 0) setCardHeight(cardEl.offsetHeight);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const sizes = new ResizeObserver(measure);
    sizes.observe(cardEl);
    return () => sizes.disconnect();
  }, [cardEl]);

  const buttons = stepButtons(step);
  const words = stepCopy(step, ctx.workspaceLabel);
  const copy: GuideCopy = {
    count: stepCountLabel(resolution.part, resolution.parts),
    title: words.title,
    body: words.body,
    next: buttons.next,
    later: buttons.later,
    laterLabel: step.laterLabel ?? 'Later',
  };
  const actions = { onNext: ctx.next, onLater: ctx.later };

  const dialog = topDialog();
  const control: Rect | undefined = el !== undefined ? rectOf(el) : undefined;
  const insideDialog = dialog.open && el !== undefined && dialog.el.contains(el);
  // An open sheet that does not hold the control covers it: no box, the strip says what to do.
  const box = control !== undefined && (!dialog.open || insideDialog) ? control : undefined;

  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const cardWidth = laptop ? CARD_WIDTH : viewport.width - 32;
  let overlay: ReactElement;
  if (dialog.open) {
    overlay = (
      <GuideStrip
        copy={copy}
        actions={actions}
        rect={stripRect(dialogTitleRect(dialog.el), rectOf(dialog.el))}
      />
    );
  } else {
    const insets = {
      top: safeTop.current?.offsetHeight ?? 0,
      bottom: (safeBottom.current?.offsetHeight ?? 0) + (tabsShown && !laptop ? PHONE_TAB_BAR : 0),
    };
    // No control on screen yet: an anchor in the corner docks the card at the
    // bottom on a phone and bottom right on a laptop.
    const anchor =
      box ??
      (laptop
        ? { top: viewport.height, left: viewport.width, width: 0, height: 0 }
        : { top: 0, left: 0, width: 0, height: 0 });
    const at = placeCard({
      target: anchor,
      card: { width: cardWidth, height: cardHeight },
      viewport,
      phone: !laptop,
      insets,
    });
    overlay = (
      <GuideCard
        ref={setCardEl}
        copy={copy}
        actions={actions}
        at={{ top: at.top, left: at.left, width: cardWidth }}
      />
    );
  }

  return createPortal(
    <div {...{ [LAYER_ATTR]: '' }} data-induction-step={step.id}>
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
      {box !== undefined && el !== undefined ? (
        <GuideBox rect={clampToViewport(boxRect(box), viewport)} radius={boxRadius(radiusOf(el))} />
      ) : null}
      {overlay}
    </div>,
    document.body,
  );
}

/** How long after a step starts the guide keeps its control in view (a thread re-sticking to its bottom). */
const BRING_WINDOW_MS = 1500;

/**
 * When a step starts, scroll its control into view if it sits off screen, and
 * keep doing so for a moment while the page settles (a chat thread scrolls to
 * its newest message after it loads). After that the person's own scrolling wins.
 * Instant, so reduced motion holds.
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

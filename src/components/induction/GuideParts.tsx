// The guide's three pieces, presentational only: the accent box around the
// control, the small card beside it, and the one-line strip inside an open
// sheet. No dimming, no backdrop: the app stays fully visible and usable, the
// box never takes a pointer, and colours are tokens only (light and dark hold).

import { forwardRef, type ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import type { Rect } from '@/lib/induction';

/** Above page content and Sheet (z-50); below toasts (z-60/70) and the lightbox (z-80). */
export const GUIDE_Z = 'z-[55]';

/**
 * The box is placed in page coordinates (absolute, the live rect plus the
 * page scroll), not fixed to the screen: when the iOS keyboard opens, Safari
 * pans the page under fixed elements, and a fixed box drifts off its control.
 */
export function GuideBox({ rect, radius }: { rect: Rect; radius: number }): ReactElement {
  return (
    <div
      data-induction-box=""
      aria-hidden="true"
      className={`pointer-events-none absolute ${GUIDE_Z} border-2 border-accent`}
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

export interface GuideCopy {
  count: string;
  title: string;
  body: string;
  next: boolean;
  later: boolean;
  laterLabel: string;
}

export interface GuideActions {
  onNext: () => void;
  onLater: () => void;
}

export const GuideCard = forwardRef<
  HTMLElement,
  { copy: GuideCopy; actions: GuideActions; at: { top: number; left: number; width: number } }
>(function GuideCard({ copy, actions, at }, ref) {
  return (
    <section
      ref={ref}
      data-induction-card=""
      aria-label="Guide"
      aria-live="polite"
      className={`fixed ${GUIDE_Z} rounded-xl border border-border-strong bg-panel p-3.5 text-fg shadow-2xl`}
      style={{ top: at.top, left: at.left, width: at.width }}
    >
      <p className="font-mono text-[11px] text-fg-3">{copy.count}</p>
      <p className="mt-1 text-[15px] font-semibold leading-snug [text-wrap:balance]">
        {copy.title}
      </p>
      <p className="mt-0.5 text-[13px] leading-snug text-fg-2 [text-wrap:pretty]">{copy.body}</p>
      {copy.next || copy.later ? (
        <div className="mt-3 flex items-center justify-end gap-2">
          {copy.later ? (
            <Button variant="ghost" size="lg" onClick={actions.onLater}>
              {copy.laterLabel}
            </Button>
          ) : null}
          {copy.next ? (
            <Button variant="primary" size="lg" onClick={actions.onNext}>
              Next
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
});

/** Inside an open sheet or dialog: one line under its title instead of a card. */
export function GuideStrip({
  copy,
  actions,
  rect,
}: {
  copy: GuideCopy;
  actions: GuideActions;
  rect: Rect;
}): ReactElement {
  return (
    <div
      data-induction-strip=""
      role="status"
      className={`fixed ${GUIDE_Z} flex items-center gap-2 rounded-md bg-accent-soft px-2 text-[12px] text-fg`}
      style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
    >
      <span className="min-w-0 flex-1 truncate">
        <span className="font-mono text-fg-3">{copy.count}</span>
        <span className="font-semibold"> {copy.title}</span>
      </span>
      {copy.later ? <StripButton label={copy.laterLabel} onClick={actions.onLater} /> : null}
      {copy.next ? <StripButton label="Next" onClick={actions.onNext} strong /> : null}
    </div>
  );
}

/** A 44px tall hit area that only takes the strip's 24px of layout. */
function StripButton({
  label,
  onClick,
  strong = false,
}: {
  label: string;
  onClick: () => void;
  strong?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-my-[10px] flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center whitespace-nowrap px-1.5 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${strong ? 'text-accent' : 'text-fg-2'}`}
    >
      {label}
    </button>
  );
}

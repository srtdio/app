// The guide's hand on the pre-app screens (OnboardingFlow): the hairline and
// the hand on one Continue, the creator route's entry taps (entryTargets).
// No bar and no label: the screen carries its own progress and words, and its
// fields stay free to use. While the control moves, or a sheet covers it,
// nothing shows; the shell's guide takes over once the flow ends.

import { type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { boxRect, clampToViewport, guideRadius, handPoint } from '@/lib/induction';
import type { InductionKey } from '@/lib/induction-keys';
import { GuideBox, GuideHand, GuideStyle } from './GuideParts';
import { findVisible, LAYER_ATTR, radiusOf, rectOf } from './guide-dom';
import { useLiveTick } from './useLiveTick';

export function EntryHand({ target }: { target: InductionKey | null }): ReactElement | null {
  const found = target !== null ? findVisible([target]) : undefined;
  const el = found?.found === true ? found.el : undefined;
  const moving = useLiveTick(el);
  if (target === null || el === undefined || moving) return null;
  const control = rectOf(el);
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  return createPortal(
    <div {...{ [LAYER_ATTR]: '' }} data-induction-entry={target}>
      <GuideStyle />
      <GuideBox
        rect={clampToViewport(boxRect(control), viewport)}
        radius={guideRadius(radiusOf(el))}
      />
      <GuideHand tip={handPoint(control)} nudge={0} />
    </div>,
    document.body,
  );
}

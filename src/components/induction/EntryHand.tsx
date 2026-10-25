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
import { findVisible, isUnavailable, LAYER_ATTR, radiusOf, rectOf } from './guide-dom';
import { useTypingNow } from './guide-hooks';
import { useLiveTick } from './useLiveTick';
import { viewportSize } from '@/lib/use-is-laptop';

export function EntryHand({ target }: { target: InductionKey | null }): ReactElement | null {
  const found = target !== null ? findVisible([target]) : undefined;
  const el = found?.found === true ? found.el : undefined;
  const moving = useLiveTick(el);
  // Not mid-word (it waits for a pause in typing), nor on a disabled Continue.
  const typing = useTypingNow();
  if (target === null || el === undefined || moving) return null;
  if (typing || isUnavailable(el)) return null;
  const control = rectOf(el);
  const viewport = viewportSize();
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

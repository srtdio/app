import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProgressRing, ringCircumference, ringDashOffset } from '@/components/ui/ProgressRing';

describe('ProgressRing', () => {
  it('geometry: circumference from the box minus the stroke; offset clamps 0..1', () => {
    expect(ringCircumference(56, 3)).toBeCloseTo(2 * Math.PI * 26.5);
    expect(ringDashOffset(0, 56, 3, 0.25)).toBeCloseTo(ringCircumference(56, 3));
    expect(ringDashOffset(1, 56, 3, 0.25)).toBe(0);
    expect(ringDashOffset(2, 56, 3, 0.25)).toBe(0);
    expect(ringDashOffset(-1, 56, 3, 0.25)).toBeCloseTo(ringCircumference(56, 3));
    // Unknown progress draws the partial arc.
    expect(ringDashOffset(null, 56, 3, 0.25)).toBeCloseTo(ringCircumference(56, 3) * 0.75);
  });

  it('renders the track and the arc from the top, inks from the caller', () => {
    const html = renderToStaticMarkup(
      <ProgressRing
        progress={0.6}
        size={56}
        stroke={3}
        arc={0.25}
        className="h-14 w-14"
        trackClass="text-overlay-dot"
        arcClass="text-overlay-fg"
      />,
    );
    expect(html).toContain('viewBox="0 0 56 56" class="h-14 w-14 -rotate-90"');
    expect(html).toContain('r="26.5"');
    expect(html).toContain('class="text-overlay-dot"');
    expect(html).toMatch(
      /data-upload-arc=""[^>]*stroke-linecap="round"[^>]*class="text-overlay-fg"/,
    );
    expect(html).toContain(`stroke-dashoffset="${String(ringDashOffset(0.6, 56, 3, 0.25))}"`);
  });
});

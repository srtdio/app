// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentType } from 'react';
import {
  IconAssets,
  IconBriefs,
  IconChat,
  IconPipeline,
  IconPlan,
  type IconProps,
} from '@/components/ui/icons';

// The five primary-tab icons wrap Heroicons 24/outline on the Svg contract:
// size in px (default 18), stroke 1.7, decorative, and the same inline layout.
const NAV_ICONS: Array<[string, ComponentType<IconProps>]> = [
  ['IconPipeline', IconPipeline],
  ['IconBriefs', IconBriefs],
  ['IconAssets', IconAssets],
  ['IconChat', IconChat],
  ['IconPlan', IconPlan],
];

function svgOf(Icon: ComponentType<IconProps>, props: IconProps = {}): SVGSVGElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<Icon {...props} />);
  const svg = host.querySelector('svg');
  if (svg === null) throw new Error('no svg');
  return svg;
}

describe('primary nav icons (Heroicons outline)', () => {
  for (const [name, Icon] of NAV_ICONS) {
    describe(name, () => {
      it('renders an svg sized to size, stroke 1.7, aria-hidden', () => {
        for (const size of [18, 20]) {
          const svg = svgOf(Icon, { size });
          expect(svg.getAttribute('width')).toBe(String(size));
          expect(svg.getAttribute('height')).toBe(String(size));
          expect(svg.style.width).toBe(`${size}px`);
          expect(svg.style.height).toBe(`${size}px`);
          expect(svg.getAttribute('stroke-width')).toBe('1.7');
          expect(svg.getAttribute('aria-hidden')).toBe('true');
        }
      });

      it('defaults to 18 and passes className through', () => {
        const svg = svgOf(Icon, { className: 'text-accent' });
        expect(svg.getAttribute('width')).toBe('18');
        expect(svg.getAttribute('class')).toContain('text-accent');
        expect(svg.style.display).toBe('');
      });

      it('inline sets display inline-block and the text baseline nudge', () => {
        const svg = svgOf(Icon, { inline: true });
        expect(svg.style.display).toBe('inline-block');
        expect(svg.style.verticalAlign).toBe('-0.15em');
      });
    });
  }
});

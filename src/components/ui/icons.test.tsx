// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentType } from 'react';
import * as Icons from '@/components/ui/icons';
import { ICON_SIZE, type IconProps } from '@/components/ui/icons';

// The documented set: every shared icon, one drawing per concept.
const DOCUMENTED = [
  'IconActivity',
  'IconAlarmClock',
  'IconAlertTriangle',
  'IconArrowUp',
  'IconArrowUpRight',
  'IconAssets',
  'IconAt',
  'IconBan',
  'IconBookmark',
  'IconBriefs',
  'IconCalendar',
  'IconCalendarClock',
  'IconCamera',
  'IconCarousel',
  'IconChat',
  'IconCheck',
  'IconCheckCircle',
  'IconChevronDown',
  'IconChevronLeft',
  'IconChevronRight',
  'IconClock',
  'IconCopy',
  'IconDownload',
  'IconDraft',
  'IconEdit',
  'IconEye',
  'IconEyeOff',
  'IconFile',
  'IconFilterLines',
  'IconForward',
  'IconGrip',
  'IconHand',
  'IconHistory',
  'IconHourglass',
  'IconImage',
  'IconImagePlus',
  'IconInfo',
  'IconLink',
  'IconLock',
  'IconMenu',
  'IconMic',
  'IconMinus',
  'IconMoon',
  'IconMore',
  'IconNotifications',
  'IconPaperclip',
  'IconPause',
  'IconPauseFill',
  'IconPhoto',
  'IconPin',
  'IconPipeline',
  'IconPlan',
  'IconPlay',
  'IconPlus',
  'IconReply',
  'IconRotateCcw',
  'IconScrollText',
  'IconSearch',
  'IconSelectText',
  'IconSend',
  'IconSettings',
  'IconSignOut',
  'IconSignpost',
  'IconSmile',
  'IconSort',
  'IconStar',
  'IconStarFilled',
  'IconSun',
  'IconSwitch',
  'IconTarget',
  'IconTaskSquare',
  'IconText',
  'IconTickDouble',
  'IconTickSingle',
  'IconTrash',
  'IconUpload',
  'IconUser',
  'IconVideo',
  'IconX',
];

// 24/solid, filled states only: no stroke.
const SOLID = new Set(['IconPlay', 'IconPauseFill', 'IconStarFilled']);
// Fixed-box glyphs whose size prop is ignored.
const FIXED_BOX: Record<string, [string, string]> = {
  IconTickSingle: ['16', '12'],
  IconTickDouble: ['20', '12'],
};

const iconEntries = Object.entries(Icons).filter(([name]) => name.startsWith('Icon')) as Array<
  [string, ComponentType<IconProps>]
>;

function svgOf(Icon: ComponentType<IconProps>, props: IconProps = {}): SVGSVGElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<Icon {...props} />);
  const svg = host.querySelector('svg');
  if (svg === null) throw new Error('no svg');
  return svg;
}

describe('icon set', () => {
  it('exports exactly the documented set', () => {
    expect(iconEntries.map(([name]) => name).sort()).toEqual([...DOCUMENTED].sort());
  });

  it('exports the one size scale', () => {
    expect(ICON_SIZE).toEqual({ inline: 16, nav: 18, control: 20, tray: 22, status: 28 });
  });

  for (const [name, Icon] of iconEntries) {
    describe(name, () => {
      it('renders an aria-hidden svg sized by the size prop', () => {
        for (const size of [ICON_SIZE.inline, ICON_SIZE.control, ICON_SIZE.status]) {
          const svg = svgOf(Icon, { size });
          const fixed = FIXED_BOX[name];
          expect(svg.getAttribute('width')).toBe(fixed !== undefined ? fixed[0] : String(size));
          expect(svg.getAttribute('height')).toBe(fixed !== undefined ? fixed[1] : String(size));
          expect(svg.getAttribute('aria-hidden')).toBe('true');
        }
      });

      it('defaults to nav size and passes className through', () => {
        const svg = svgOf(Icon, { className: 'text-accent' });
        if (FIXED_BOX[name] === undefined) {
          expect(svg.getAttribute('width')).toBe(String(ICON_SIZE.nav));
        }
        expect(svg.getAttribute('class')).toContain('text-accent');
      });

      it(SOLID.has(name) ? 'is solid, no stroke width' : 'strokes at 1.7', () => {
        const svg = svgOf(Icon);
        if (SOLID.has(name)) {
          expect(svg.getAttribute('stroke-width')).toBeNull();
          expect(svg.getAttribute('fill')).toBe('currentColor');
        } else {
          expect(svg.getAttribute('stroke-width')).toBe('1.7');
        }
      });

      it('inline sets display inline-block and the text baseline nudge', () => {
        const svg = svgOf(Icon, { inline: true });
        expect(svg.style.display).toBe('inline-block');
        expect(svg.style.verticalAlign).toBe('-0.15em');
      });
    });
  }
});

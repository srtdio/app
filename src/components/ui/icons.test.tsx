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
  'IconArchive',
  'IconArrowUp',
  'IconArrowUpRight',
  'IconAssets',
  'IconAt',
  'IconBan',
  'IconBank',
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
  'IconCollapse',
  'IconCopy',
  'IconDownload',
  'IconDraft',
  'IconEdit',
  'IconExpand',
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
  'IconMail',
  'IconMailOff',
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

  it('strokeFor: 2 at 12-16, 1.85 at 18-20, 1.6 at 22-28; ICON_SIZE unchanged', () => {
    expect(Icons.strokeFor(ICON_SIZE.text)).toBe(2);
    expect(Icons.strokeFor(ICON_SIZE.inline)).toBe(2);
    expect(Icons.strokeFor(ICON_SIZE.nav)).toBe(1.85);
    expect(Icons.strokeFor(ICON_SIZE.control)).toBe(1.85);
    expect(Icons.strokeFor(ICON_SIZE.tray)).toBe(1.6);
    expect(Icons.strokeFor(ICON_SIZE.status)).toBe(1.6);
  });

  it('exports the one size scale', () => {
    expect(ICON_SIZE).toEqual({
      text: 12,
      inline: 16,
      nav: 18,
      control: 20,
      tray: 22,
      status: 28,
    });
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

      it(SOLID.has(name) ? 'is solid, no stroke width' : 'strokes per size (2 / 1.85 / 1.6)', () => {
        const svg = svgOf(Icon);
        if (SOLID.has(name)) {
          expect(svg.getAttribute('stroke-width')).toBeNull();
          expect(svg.getAttribute('fill')).toBe('currentColor');
        } else {
          expect(svg.getAttribute('stroke-width')).toBe('1.85');
          if (FIXED_BOX[name] === undefined) {
            expect(svgOf(Icon, { size: ICON_SIZE.inline }).getAttribute('stroke-width')).toBe('2');
            expect(svgOf(Icon, { size: ICON_SIZE.control }).getAttribute('stroke-width')).toBe(
              '1.85',
            );
            expect(svgOf(Icon, { size: ICON_SIZE.tray }).getAttribute('stroke-width')).toBe('1.6');
            expect(svgOf(Icon, { size: ICON_SIZE.status }).getAttribute('stroke-width')).toBe(
              '1.6',
            );
          }
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

describe('non-icon glyphs drawn in the icon file', () => {
  it('TaskBoxGlyph: To do is an fg-3 outline square, Done an accent square with a panel tick', () => {
    const todo = renderToStaticMarkup(<Icons.TaskBoxGlyph done={false} size={ICON_SIZE.nav} />);
    expect(todo).toContain('width="18"');
    expect(todo).toContain('viewBox="0 0 16 16"');
    expect(todo).toContain('stroke-width="1.85"');
    expect(todo).toContain('class="text-fg-3"');
    expect(todo).toContain('rx="3.6" stroke="currentColor"');
    const done = renderToStaticMarkup(<Icons.TaskBoxGlyph done size={ICON_SIZE.inline} />);
    expect(done).toContain('width="16"');
    expect(done).toContain('class="text-accent"');
    expect(done).toContain('fill="currentColor"');
    expect(done).toContain('class="stroke-panel"');
  });

  it('DrawnMarkGlyph: the approve tick and reject cross as drawable strokes (pathLength 1, dash 1), drawn at rest', () => {
    const tick = renderToStaticMarkup(<Icons.DrawnMarkGlyph mark="tick" className="text-good" />);
    expect(tick).toContain('d="m4.5 12.75 6 6 9-13.5"');
    expect(tick).toContain('pathLength="1"');
    expect(tick).toContain('stroke-dasharray="1"');
    expect(tick).toContain('stroke-width="2"');
    expect(tick).toContain('width="16"');
    expect(tick).toContain('class="text-good"');
    // Final state first: no offset at rest, so it shows fully drawn with motion off.
    expect(tick).not.toContain('stroke-dashoffset');
    const cross = renderToStaticMarkup(
      <Icons.DrawnMarkGlyph mark="cross" size={ICON_SIZE.control} />,
    );
    expect(cross.match(/data-draw=""/g)).toHaveLength(2);
    expect(cross).toContain('width="20"');
  });

  it('RailCurveGlyph: a 13px quarter curve, 2px stroke in the stronger border token', () => {
    const tick = renderToStaticMarkup(
      <Icons.RailCurveGlyph turn="tick" className="bottom-0 left-0" />,
    );
    expect(tick).toContain('d="M1 0A12 12 0 0 0 13 12"');
    expect(tick).toContain(
      'class="absolute h-[13px] w-[13px] overflow-visible text-border-strong bottom-0 left-0"',
    );
    expect(tick).toContain('stroke-width="2"');
    const elbow = renderToStaticMarkup(
      <Icons.RailCurveGlyph turn="elbow" className="left-0 top-0" />,
    );
    expect(elbow).toContain('d="M13 1A12 12 0 0 0 1 13"');
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Text, TEXT_ROLE, textRole } from '@/components/ui/Text';
import { Card } from '@/components/ui/Card';
import { Row } from '@/components/ui/Row';
import { ChatCard } from '@/components/ui/ChatCard';
import { Toolbar } from '@/components/ui/Toolbar';
import { ComposerFrame, composerHint } from '@/components/ui/Composer';
import { Tile } from '@/components/ui/Tile';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { StatusDot } from '@/components/ui/StatusDot';
import { ActionMenuTrigger } from '@/components/ui/ActionMenu';
import { SheetActions } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { IconBriefs } from '@/components/ui/icons';

vi.mock('@/lib/use-is-laptop', async (orig) => ({
  ...(await orig<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => false,
}));

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node);

describe('Text roles', () => {
  it('eight roles on the existing scale', () => {
    expect(Object.keys(TEXT_ROLE).sort()).toEqual(
      ['body', 'display', 'heading', 'label', 'meta', 'secondary', 'section', 'title'].sort(),
    );
    expect(TEXT_ROLE.section).toBe('text-sm font-semibold uppercase tracking-label text-fg-2');
    expect(TEXT_ROLE.display).toContain('text-3xl');
    expect(TEXT_ROLE.title).toBe('text-lg font-semibold');
    expect(TEXT_ROLE.heading).toBe('text-lg font-semibold');
    expect(TEXT_ROLE.body).toContain('text-base');
    expect(TEXT_ROLE.secondary).toContain('text-md');
    expect(TEXT_ROLE.secondary).toContain('truncate');
    expect(TEXT_ROLE.label).toContain('font-medium');
    expect(TEXT_ROLE.meta).toContain('font-mono');
    expect(TEXT_ROLE.meta).toContain('tabular-nums');
    expect(TEXT_ROLE.meta).toContain('text-fg-3');
  });
  it('no role uses an arbitrary size or a leading override', () => {
    for (const cls of Object.values(TEXT_ROLE)) {
      expect(cls).not.toMatch(/text-\[|leading-/);
    }
  });
  it('textRole merges layout classes, last colour wins', () => {
    expect(textRole('meta', 'text-fg')).toContain('text-fg');
    expect(textRole('meta', 'text-fg')).not.toContain('text-fg-3');
  });
  it('<Text role> renders the element and the role classes', () => {
    expect(html(<Text role="meta">2:14 PM</Text>)).toBe(
      `<span class="${TEXT_ROLE.meta}">2:14 PM</span>`,
    );
    expect(
      html(
        <Text role="title" as="h1">
          Pipeline
        </Text>,
      ),
    ).toContain('<h1');
  });
});

describe('Card', () => {
  it('renders every slot and the 16 inset (12 dense)', () => {
    const out = html(
      <Card
        title="Diwali reel"
        time="2:14 PM"
        meta="12 Oct"
        badge={<span>Review</span>}
        footerTrailing="3 files"
      >
        body
      </Card>,
    );
    expect(out).toContain('data-card-header');
    expect(out).toContain('Diwali reel');
    expect(out).toContain('data-card-footer');
    expect(out).toContain('p-4');
    expect(out).toContain('rounded-xl');
    expect(out).toContain('lit-card');
    expect(out).toContain('self-start');
    expect(html(<Card dense title="x" />)).toContain('p-3');
  });
  it('media bleeds with top corners, or sits inset with radius 4', () => {
    expect(html(<Card media={<img alt="" />} />)).toContain('rounded-t-xl');
    expect(html(<Card media={<img alt="" />} mediaInset />)).toContain('rounded-inset');
  });
});

describe('Row', () => {
  it('56 one line, 72 two lines, text at 60, divider inset 60', () => {
    expect(html(<Row title="Ana" onPress={() => {}} />)).toContain('min-h-14');
    const two = html(<Row title="Ana" secondary="Hello" divider onPress={() => {}} />);
    expect(two).toContain('min-h-18');
    expect(two).toContain('left-15');
    expect(two).toContain('gap-3');
    expect(two).toContain('px-4');
  });
  it('chevron OR more, never both; chevron is fg-3', () => {
    const chev = html(<Row title="Ana" trailing={{ kind: 'chevron' }} onPress={() => {}} />);
    expect(chev).toContain('data-row-chevron');
    expect(chev).toMatch(/data-row-chevron=""[^>]*text-fg-3/);
    const more = html(
      <Row
        title="Ana"
        trailing={{ kind: 'more', menu: <ActionMenuTrigger /> }}
        onPress={() => {}}
      />,
    );
    expect(more).toContain('data-row-more');
    expect(more).not.toContain('data-row-chevron');
  });
});

describe('Row badge slot and tap surface (B1b)', () => {
  it('the badge sits on the second line after the secondary text, never a control', () => {
    const out = html(
      <Row title="Launch" secondary="See you" badge={<span>3</span>} onPress={() => {}} />,
    );
    expect(out).toContain('data-row-badge');
    expect(out.indexOf('See you')).toBeLessThan(out.indexOf('data-row-badge'));
    // Without a second line the badge follows the time on the title line.
    const one = html(<Row title="Launch" time="09:00" badge={<span>3</span>} onPress={() => {}} />);
    expect(one.indexOf('09:00')).toBeLessThan(one.indexOf('data-row-badge'));
    expect(one).toContain('min-h-14');
    // No badge, no slot.
    expect(html(<Row title="Launch" onPress={() => {}} />)).not.toContain('data-row-badge');
  });
  it('forwards the tap surface attributes (name, pressed, hooks), never its classes', () => {
    const out = html(
      <Row
        title="Launch"
        onPress={() => {}}
        aria-label="Open Launch"
        aria-pressed={true}
        data-notes-tile=""
      />,
    );
    expect(out).toMatch(/<button[^>]*aria-label="Open Launch"/);
    expect(out).toMatch(/<button[^>]*aria-pressed="true"/);
    expect(out).toMatch(/<button[^>]*data-notes-tile=""/);
  });
});

describe('ChatCard', () => {
  it('the card is the bubble: bubble radius, no wrapper, time bottom-trailing', () => {
    const out = html(<ChatCard icon={IconBriefs} title="Brief" meta="Open" time="2:14 PM" />);
    expect(out.match(/data-chat-card=""/g)).toHaveLength(1);
    expect(out).toContain('rounded-[18px]');
    expect(out).toContain('data-chat-card-time');
    expect(out).toContain('self-end');
  });
  it('an action row: secondary left, primary right, 44 tall, no divider', () => {
    const out = html(
      <ChatCard
        icon={IconBriefs}
        title="Plan"
        secondaryAction={<Button>Forward</Button>}
        primaryAction={<Button variant="primary">Open plan</Button>}
      />,
    );
    expect(out).toMatch(/data-chat-card-actions=""[^>]*min-h-11/);
    expect(out.indexOf('Forward')).toBeLessThan(out.indexOf('Open plan'));
    expect(out).not.toMatch(/data-chat-card-actions=""[^>]*border-t/);
  });
});

describe('Toolbar', () => {
  it('56 bar on the gutter; primary last', () => {
    const out = html(
      <Toolbar
        context={<input aria-label="Search" />}
        icons={<button>i</button>}
        primary={<button>New</button>}
      />,
    );
    expect(out).toContain('h-14');
    expect(out).toContain('px-4 md:px-6');
    expect(out.indexOf('data-toolbar-icons')).toBeLessThan(out.indexOf('data-toolbar-primary'));
  });
});

describe('Composer', () => {
  it('hint is "Message", "Reply" while replying', () => {
    expect(composerHint(false)).toBe('Message');
    expect(composerHint(true)).toBe('Reply');
  });
  it('every state keeps the one row', () => {
    for (const state of [
      { kind: 'idle' as const },
      { kind: 'recording' as const, elapsed: '0:07' },
      { kind: 'sending' as const },
      { kind: 'scheduling' as const },
    ]) {
      const out = html(
        <ComposerFrame
          leading={<button>+</button>}
          input={<textarea aria-label="Message" />}
          send={<button>Send</button>}
          discard={<button>Bin</button>}
          state={state}
        />,
      );
      expect(out.match(/data-composer-row=""/g)).toHaveLength(1);
      expect(out).toContain('Send');
    }
    const rec = html(
      <ComposerFrame
        leading={<button>Plus</button>}
        input={<textarea />}
        send={<button>Send</button>}
        discard={<button>Bin</button>}
        state={{ kind: 'recording', elapsed: '0:07' }}
      />,
    );
    expect(rec).toContain('Recording');
    expect(rec).toContain('Bin');
    expect(rec).not.toContain('Plus');
    expect(rec).toContain('font-mono');
  });
  it('the reply strip is above the row, never inside it', () => {
    const out = html(
      <ComposerFrame
        strip={<span>Replying</span>}
        input={<textarea />}
        send={<button>Send</button>}
      />,
    );
    expect(out.indexOf('data-composer-strip')).toBeLessThan(out.indexOf('data-composer-row'));
  });
});

describe('Tile', () => {
  it('thumbnail radius 8, caption below, meta slot kept without a preview', () => {
    const out = html(<Tile thumbnail={<img alt="" />} title="Ana" />);
    expect(out).toContain('rounded-lg');
    expect(out).toContain('font-mono');
    expect(out).toContain('h-full');
  });
  it('overlays only at corners', () => {
    const out = html(
      <Tile thumbnail={<img alt="" />} title="x" corners={{ tr: <span>v</span> }} />,
    );
    expect(out).toContain('data-tile-corner="tr"');
    expect(out).toContain('right-0 top-0');
  });
});

describe('Tile press slot (B1b)', () => {
  it('the whole tile is one tap surface around thumbnail and caption; the ⋯ stays outside it', () => {
    const out = html(
      <Tile
        thumbnail={<img alt="thumb" />}
        title="Ana"
        meta="09:00"
        more={<ActionMenuTrigger />}
        press={{ 'aria-label': 'Open Ana', onClick: () => {}, selected: true }}
      />,
    );
    expect(out).toMatch(/data-tile=""[^>]*relative/);
    expect(out).toMatch(/<button[^>]*class="[^"]*lit-selected[^"]*"[^>]*data-tile-press=""/);
    expect(out).toMatch(/<button[^>]*aria-label="Open Ana"/);
    // Thumbnail and caption inside the surface (a text tap is a surface tap).
    const close = out.indexOf('</button>');
    expect(out.indexOf('alt="thumb"')).toBeLessThan(close);
    expect(out.indexOf('>Ana<')).toBeLessThan(close);
    // Buttons never nest: the ⋯ comes after the surface closes, its box kept free.
    expect(out.indexOf('data-tile-more')).toBeGreaterThan(close);
    expect(out).toMatch(/data-tile-more=""[^>]*pointer-events-auto -my-3/);
    expect(out).toContain('-my-3 h-11 w-8 shrink-0');
  });
  it('no press: no surface, the tile stays static', () => {
    const out = html(<Tile thumbnail={<img alt="" />} title="Ana" />);
    expect(out).not.toContain('data-tile-press');
    expect(out).not.toContain('<button');
  });
});

describe('HeaderBar backProps (B1b)', () => {
  it("names the back and carries its hooks; the look, glyph and pull stay the part's", () => {
    const out = html(
      <HeaderBar
        title="Thread"
        onBack={() => {}}
        backProps={{ label: 'Close thread', 'data-thread-view-close': '' }}
      />,
    );
    expect(out).toContain('aria-label="Close thread"');
    expect(out).toContain('data-thread-view-close=""');
    expect(out).toContain('-ml-3');
    expect(out.match(/<button/g)).toHaveLength(1);
    // Default label stays Back.
    expect(html(<HeaderBar title="x" onBack={() => {}} />)).toContain('aria-label="Back"');
  });
});

describe('HeaderBar', () => {
  it('56/64 on the gutter; back is "<" labelled Back, pulled to the edge', () => {
    const out = html(<HeaderBar title="Group info" onBack={() => {}} />);
    expect(out).toContain('h-14 md:h-16');
    expect(out).toContain('aria-label="Back"');
    expect(out).toContain('-ml-3');
    expect(out).toContain('truncate');
  });
});

describe('trailing rule and small parts', () => {
  it('ActionMenuTrigger owns the trailing pull; free opts out', () => {
    expect(html(<ActionMenuTrigger />)).toContain('-mr-3');
    expect(html(<ActionMenuTrigger edge="free" />)).not.toContain('-mr-3');
    expect(html(<ActionMenuTrigger inLine />)).toContain('-my-3');
  });
  it('StatusDot is 8 with one colour per stage', () => {
    const out = html(<StatusDot stage="review" />);
    expect(out).toContain('h-2 w-2');
    expect(out).toContain('bg-stage-review');
  });
  it('SheetActions: phone equal halves, laptop right-aligned with primary last', () => {
    const out = html(
      <SheetActions cancel={<Button>Cancel</Button>} primary={<Button>Save</Button>} />,
    );
    expect(out).toContain('flex-1 md:flex-none');
    expect(out.indexOf('Cancel')).toBeLessThan(out.indexOf('Save'));
  });
});

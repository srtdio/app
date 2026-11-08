// @vitest-environment jsdom
// ui/WritingBox: the chat pill on a phone, the card on focus / with text, the
// Aa row swap (laptop: Aa closes it; phone: X close and send as matching
// filled circles, a selection opens the row), caption mode with no Aa row,
// field mode rows on focus, expand / collapse keeping the same field (no
// remount), one collapse key, the mic beside send, an "on" key's ink glyph
// (never a tile or ring), the + tray as the top of the box.
import { act, useRef, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WritingBox, type WritingMode } from '@/components/ui/WritingBox';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function Harness(props: { mode: WritingMode; laptop?: boolean; initial?: string }): ReactElement {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [text, setText] = useState(props.initial ?? '');
  return (
    <WritingBox
      mode={props.mode}
      laptop={props.laptop ?? false}
      field={() => ref.current}
      hasText={text !== ''}
      mention={props.mode !== 'field'}
      leading={<span data-testid="plus">+</span>}
      pillEnd={<span data-testid="mic">mic</span>}
      send={<span data-testid="send">send</span>}
      expandTitle="Caption"
      input={
        <textarea
          ref={ref}
          aria-label="Message"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      }
    />
  );
}

function mount(node: ReactElement): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

const q = (host: HTMLElement, sel: string): HTMLElement | null => host.querySelector(sel);
const byLabel = (host: HTMLElement, label: string): HTMLElement | null =>
  host.querySelector(`[aria-label="${label}"]`);

describe('WritingBox chat mode', () => {
  it('phone idle: one pill with +, the field and the mic; no send, no Aa', () => {
    const host = mount(<Harness mode="chat" />);
    expect(q(host, '[data-writing-box]')?.dataset.shape).toBe('pill');
    expect(q(host, '[data-testid="mic"]')).not.toBeNull();
    expect(q(host, '[data-testid="send"]')).toBeNull();
    expect(byLabel(host, 'Aa')).toBeNull();
  });

  it('focus turns it into the card: + Aa Emoji Mention ... send, no mic', () => {
    const host = mount(<Harness mode="chat" />);
    const area = byLabel(host, 'Message') as HTMLTextAreaElement;
    act(() => area.focus());
    expect(q(host, '[data-writing-box]')?.dataset.shape).toBe('card');
    expect(byLabel(host, 'Aa')).not.toBeNull();
    expect(byLabel(host, 'Emoji')).not.toBeNull();
    expect(byLabel(host, 'Mention')).not.toBeNull();
    expect(q(host, '[data-testid="send"]')).not.toBeNull();
    expect(q(host, '[data-testid="mic"]')).toBeNull();
    // The field never remounts between pill and card.
    expect(byLabel(host, 'Message')).toBe(area);
  });

  it('laptop: Aa swaps the row for the format row; Aa (on) closes it, no X', () => {
    const host = mount(<Harness mode="chat" laptop initial="hi" />);
    act(() => byLabel(host, 'Aa')?.click());
    const labels = [...host.querySelectorAll('[data-format-row] [aria-label]')].map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels).toEqual([
      'Aa',
      'Bold',
      'Italic',
      'Underline',
      'Strike',
      'Link',
      'Numbered list',
      'Bullet list',
      'Quote',
    ]);
    expect(q(host, '[data-testid="send"]')).not.toBeNull();
    expect(byLabel(host, 'Close formatting')).toBeNull();
    const aa = q(host, '[data-format-row] [data-row-key="aa"]');
    expect(aa?.getAttribute('aria-pressed')).toBe('true');
    // Aa on: the glyph turns ink, never a tile or ring.
    expect(aa?.querySelector('span')?.className).toContain('text-fg');
    expect(aa?.querySelector('span')?.className).not.toMatch(/\bbg-|lit-selected|\bborder\b/);
    act(() => aa?.click());
    expect(q(host, '[data-format-row]')).toBeNull();
    // Back on the action row, Aa reads off again.
    expect(byLabel(host, 'Aa')?.getAttribute('aria-pressed')).toBeNull();
  });

  it('a format key that is on turns its glyph ink (fg), never a tile, ring or fill', () => {
    const host = mount(<Harness mode="chat" initial="*hi* there" />);
    const area = byLabel(host, 'Message') as HTMLTextAreaElement;
    act(() => {
      area.focus();
      area.setSelectionRange(2, 2);
    });
    act(() => byLabel(host, 'Aa')?.click());
    const bold = byLabel(host, 'Bold');
    const face = bold?.querySelector('span');
    expect(bold?.getAttribute('aria-pressed')).toBe('true');
    expect(face?.className).toMatch(/\btext-fg\b/);
    expect(face?.className).not.toMatch(/\bbg-|lit-selected|\bborder\b|\bring\b/);
    const italic = byLabel(host, 'Italic')?.querySelector('span');
    expect(italic?.className).toMatch(/\btext-fg-2\b/);
    expect(italic?.className).not.toMatch(/\bbg-|lit-selected|\bborder\b/);
  });

  it('laptop: the card always, even empty', () => {
    const host = mount(<Harness mode="chat" laptop />);
    expect(q(host, '[data-writing-box]')?.dataset.shape).toBe('card');
  });

  it('a list button numbers the caret line', () => {
    const host = mount(<Harness mode="chat" initial="one" />);
    const area = byLabel(host, 'Message') as HTMLTextAreaElement;
    act(() => {
      area.focus();
      area.setSelectionRange(3, 3);
    });
    act(() => byLabel(host, 'Aa')?.click());
    act(() => byLabel(host, 'Numbered list')?.click());
    expect(area.value).toBe('1. one');
  });
});

describe('WritingBox caption and field modes', () => {
  it('caption: emoji and @ only, never Aa', () => {
    const host = mount(<Harness mode="caption" initial="x" />);
    act(() => (byLabel(host, 'Message') as HTMLTextAreaElement).focus());
    expect(byLabel(host, 'Aa')).toBeNull();
    expect(byLabel(host, 'Bold')).toBeNull();
    expect(byLabel(host, 'Emoji')).not.toBeNull();
    expect(byLabel(host, 'Mention')).not.toBeNull();
  });

  it('caption @ types a plain "@" at the caret', () => {
    const host = mount(<Harness mode="caption" initial="hi" />);
    const area = byLabel(host, 'Message') as HTMLTextAreaElement;
    act(() => {
      area.focus();
      area.setSelectionRange(2, 2);
    });
    act(() => byLabel(host, 'Mention')?.click());
    expect(area.value).toBe('hi @');
  });

  it('field: rows only while focused; the format keys with no X, + or send', () => {
    const host = mount(<Harness mode="field" />);
    expect(q(host, '[data-writing-row]')).toBeNull();
    act(() => (byLabel(host, 'Message') as HTMLTextAreaElement).focus());
    expect(byLabel(host, 'Bold')).not.toBeNull();
    expect(byLabel(host, 'Close formatting')).toBeNull();
    expect(q(host, '[data-testid="plus"]')).toBeNull();
    expect(q(host, '[data-testid="send"]')).toBeNull();
  });
});

describe('WritingBox expand', () => {
  it('phone: the editor moves to <body> full screen with the title, keeps the field, collapses back', () => {
    const host = mount(<Harness mode="comment" initial="draft" />);
    const area = byLabel(host, 'Message');
    act(() => byLabel(host, 'Expand')?.click());
    // Out of the page's tree: no transformed or clipping ancestor can cut it.
    const box = document.querySelector<HTMLElement>('[data-writing-box]');
    expect(box?.dataset.expanded).toBe('phone');
    expect(host.contains(box)).toBe(false);
    expect(box?.closest('[data-writing-host]')?.parentElement).toBe(document.body);
    expect(document.body.textContent).toContain('Caption');
    // The same field node (never remounted), text kept.
    expect(document.querySelector('[aria-label="Message"]')).toBe(area);
    // One collapse sign while expanded (the editor's bar), never a second in the box.
    expect(document.querySelectorAll('[aria-label="Collapse"]')).toHaveLength(1);
    expect(document.querySelector('[aria-label="Expand"]')).toBeNull();
    act(() => (document.querySelectorAll('[aria-label="Collapse"]')[0] as HTMLElement).click());
    const back = q(host, '[data-writing-box]');
    expect(back).not.toBeNull();
    expect(back?.dataset.expanded).toBeUndefined();
    expect((byLabel(host, 'Message') as HTMLTextAreaElement).value).toBe('draft');
    expect(byLabel(host, 'Message')).toBe(area);
  });

  it('phone: Send from the editor puts the box back in its form first', () => {
    let sent = 0;
    const ref = { current: null as HTMLTextAreaElement | null };
    const host = mount(
      <form
        onSubmit={(e) => {
          e.preventDefault();
          sent += 1;
        }}
      >
        <WritingBox
          mode="comment"
          laptop={false}
          field={() => ref.current}
          hasText
          send={<button type="submit">Send</button>}
          input={<textarea ref={ref} aria-label="Message" defaultValue="x" />}
        />
      </form>,
    );
    act(() => byLabel(host, 'Expand')?.click());
    const send = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Send');
    act(() => send?.click());
    expect(host.querySelector('form')?.contains(send ?? null)).toBe(true);
    expect(sent).toBe(1);
  });

  it('laptop: grows in place; Esc collapses', () => {
    const host = mount(<Harness mode="comment" laptop initial="draft" />);
    act(() => byLabel(host, 'Expand')?.click());
    const box = q(host, '[data-writing-box]');
    expect(box?.dataset.expanded).toBe('laptop');
    act(() => {
      byLabel(host, 'Message')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(q(host, '[data-writing-box]')?.dataset.expanded).toBeUndefined();
  });
});

describe('WritingBox sending', () => {
  it('a voice note on its way keeps the card (the send slot shows its spinner), never the pill', () => {
    const ref = { current: null as HTMLTextAreaElement | null };
    const host = mount(
      <WritingBox
        mode="chat"
        laptop={false}
        field={() => ref.current}
        hasText={false}
        state={{ kind: 'sending' }}
        send={<span data-testid="send">busy</span>}
        input={<textarea aria-label="Message" />}
      />,
    );
    expect(q(host, '[data-writing-box]')?.dataset.shape).toBe('card');
    expect(q(host, '[data-testid="send"]')).not.toBeNull();
  });
});

describe('WritingBox pill keys', () => {
  it('focusing the + in the phone pill keeps the pill (its tray stays mounted)', () => {
    const host = mount(<Harness mode="chat" />);
    const plus = document.createElement('button');
    q(host, '[data-testid="plus"]')?.appendChild(plus);
    act(() => plus.focus());
    expect(q(host, '[data-writing-box]')?.dataset.shape).toBe('pill');
  });
});

describe('WritingBox blur', () => {
  it('keeps its rows until the press that blurred it ends (the button under it does not move)', () => {
    vi.useFakeTimers();
    try {
      const host = mount(<Harness mode="field" />);
      const area = byLabel(host, 'Message') as HTMLTextAreaElement;
      act(() => area.focus());
      expect(q(host, '[data-writing-row]')).not.toBeNull();
      act(() => area.blur());
      // Still there while the finger is down.
      expect(q(host, '[data-writing-row]')).not.toBeNull();
      act(() => {
        document.dispatchEvent(new Event('pointerup', { bubbles: true }));
        vi.runAllTimers();
      });
      expect(q(host, '[data-writing-row]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WritingBox comment line', () => {
  it('an unfocused, empty comment box keeps its + beside the field', () => {
    const host = mount(<Harness mode="comment" laptop />);
    expect(q(host, '[data-writing-box]')?.dataset.shape).toBe('line');
    expect(q(host, '[data-testid="plus"]')).not.toBeNull();
    expect(q(host, '[data-testid="send"]')).not.toBeNull();
  });
});

describe('WritingBox sheets', () => {
  it('a submit inside the sheets never reaches the composer form around the box', () => {
    let sent = 0;
    const host = mount(
      <form
        onSubmit={(e) => {
          e.preventDefault();
          sent += 1;
        }}
      >
        <Harness mode="chat" initial="draft" />
      </form>,
    );
    const sheets = q(host, '[data-writing-sheets]');
    expect(sheets).not.toBeNull();
    const inner = document.createElement('form');
    sheets?.appendChild(inner);
    act(() => {
      inner.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(sent).toBe(0);
  });
});

describe('WritingBox width', () => {
  it('never sizes its container to its rows: inline-size containment, full width', () => {
    const host = mount(<Harness mode="chat" initial="hi" />);
    act(() => byLabel(host, 'Aa')?.click());
    const cls = q(host, '[data-writing-box]')?.className ?? '';
    expect(cls).toContain('[contain:inline-size]');
    expect(cls).toContain('w-full');
    expect(cls).toContain('max-w-full');
    // The format row scrolls inside the box.
    expect(q(host, '[data-format-row]')?.className).toContain('overflow-x-auto');
  });
});

describe('WritingBox overlay', () => {
  it('at rest the overlay hangs on the box; in the phone editor it sits above the row', () => {
    const ref = { current: null as HTMLTextAreaElement | null };
    const host = mount(
      <WritingBox
        mode="comment"
        laptop={false}
        field={() => ref.current}
        hasText
        overlay={<div data-testid="picker">list</div>}
        send={<span>send</span>}
        input={<textarea ref={ref} aria-label="Message" defaultValue="x" />}
      />,
    );
    const box = q(host, '[data-writing-box]');
    expect(box?.className).toContain('relative');
    expect(q(host, '[data-testid="picker"]')?.parentElement).toBe(box);
    act(() => byLabel(host, 'Expand')?.click());
    const picker = document.querySelector('[data-testid="picker"]');
    const row = document.querySelector('[data-writing-row]');
    expect(picker?.closest('[data-writing-overlay]')?.nextElementSibling).toBe(row);
  });
});

describe('WritingBox expand icon', () => {
  it('is one diagonal arrow (open in full), not the four-arrow cross', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { IconExpand, IconCollapse } = await import('@/components/ui/icons');
    const expand = renderToStaticMarkup(<IconExpand size={20} />);
    expect(expand).toContain('d="M5 19 19 5"');
    expect(expand.match(/<path/g)).toHaveLength(3);
    expect(renderToStaticMarkup(<IconCollapse size={20} />).match(/<path/g)).toHaveLength(4);
  });
});

describe('WritingBox mic beside send', () => {
  function MicHarness(props: { laptop: boolean }): ReactElement {
    const ref = useRef<HTMLTextAreaElement | null>(null);
    const [text, setText] = useState('');
    return (
      <WritingBox
        mode="chat"
        laptop={props.laptop}
        field={() => ref.current}
        hasText={text !== ''}
        mic={<span data-testid="mic">mic</span>}
        send={<span data-testid="send">send</span>}
        input={
          <textarea
            ref={ref}
            aria-label="Message"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        }
      />
    );
  }

  function typeInto(area: HTMLTextAreaElement, value: string): void {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      set?.call(area, value);
      area.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('laptop: the mic sits right before send, empty and while typing', () => {
    const host = mount(<MicHarness laptop />);
    const order = (): string[] =>
      [...host.querySelectorAll('[data-row-trailing] [data-testid]')].map(
        (el) => el.getAttribute('data-testid') ?? '',
      );
    expect(order()).toEqual(['mic', 'send']);
    typeInto(byLabel(host, 'Message') as HTMLTextAreaElement, 'On it');
    expect(order()).toEqual(['mic', 'send']);
  });

  it('phone: the idle pill shows the mic; typing shows the card with mic and send', () => {
    const host = mount(<MicHarness laptop={false} />);
    expect(q(host, '[data-writing-box]')?.dataset.shape).toBe('pill');
    expect(q(host, '[data-testid="mic"]')).not.toBeNull();
    typeInto(byLabel(host, 'Message') as HTMLTextAreaElement, 'On it');
    expect(q(host, '[data-writing-box]')?.dataset.shape).toBe('card');
    expect(q(host, '[data-row-trailing] [data-testid="mic"]')).not.toBeNull();
    expect(q(host, '[data-row-trailing] [data-testid="send"]')).not.toBeNull();
  });
});

describe('WritingBox send', () => {
  it('RowSend stays ink with nothing to send (no tap), and when sendable', async () => {
    const { RowSend } = await import('@/components/ui/WritingBox');
    const host = mount(
      <div>
        <RowSend label="Send" disabled icon={<span />} />
        <RowSend label="Post" disabled={false} icon={<span />} />
      </div>,
    );
    for (const label of ['Send', 'Post']) {
      const face = byLabel(host, label)?.querySelector('span');
      expect(face?.className).toContain('bg-accent');
      expect(face?.className).not.toContain('bg-panel-3');
    }
    expect((byLabel(host, 'Send') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('WritingBox + tray', () => {
  it('the tray opens as the top of the same box: one outline, in flow, a column per tile', async () => {
    const { ComposerTray } = await import('@/components/chat/ComposerTray');
    const ref = { current: null as HTMLTextAreaElement | null };
    const host = mount(
      <WritingBox
        mode="comment"
        laptop
        field={() => ref.current}
        hasText={false}
        leading={
          <ComposerTray
            compact
            layout="laptop"
            only={{ tiles: ['photos', 'file', 'assets'], trayId: 't1' }}
            onPick={() => undefined}
          />
        }
        send={<span>send</span>}
        input={<textarea ref={ref} aria-label="Message" />}
      />,
    );
    act(() => byLabel(host, 'Add attachment')?.click());
    const frame = q(host, '[data-writing-frame]');
    const tray = q(host, '[data-tray]');
    expect(tray).not.toBeNull();
    // Inside the box's own frame (its outline and fill), at the top, in flow.
    expect(tray?.closest('[data-writing-tray-slot]')?.parentElement).toBe(frame);
    expect(frame?.firstElementChild).toBe(tray?.closest('[data-writing-tray-slot]'));
    expect(tray?.className).not.toContain('absolute');
    expect(tray?.className).not.toMatch(/\blit-dock\b|shadow/);
    expect(frame?.className).toContain('lit-focus-inset');
    expect(q(host, '[data-writing-box]')?.dataset.shape).toBe('card');
    // One column per tile (3), 20 icons.
    const grid = tray?.querySelector('[data-tray-cols]');
    expect(grid?.getAttribute('data-tray-cols')).toBe('3');
    expect(grid?.className).toContain('grid-cols-3');
    expect(tray?.querySelector('svg')?.getAttribute('width')).toBe('20');
    // Closing takes it away again.
    act(() => byLabel(host, 'Close attachments')?.click());
    expect(q(host, '[data-writing-box]')?.dataset.shape).toBe('line');
  });
});

describe('WritingBox phone format row', () => {
  function PhoneHarness(props: { mode?: WritingMode; initial?: string }): ReactElement {
    const ref = useRef<HTMLTextAreaElement | null>(null);
    const [text, setText] = useState(props.initial ?? '');
    return (
      <WritingBox
        mode={props.mode ?? 'chat'}
        laptop={false}
        field={() => ref.current}
        hasText={text !== ''}
        mention
        leading={<span data-testid="plus">+</span>}
        mic={<span data-testid="mic">mic</span>}
        send={<span data-testid="send">send</span>}
        input={
          <textarea
            ref={ref}
            aria-label="Message"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        }
      />
    );
  }

  const keysOf = (host: HTMLElement): (string | null)[] =>
    [...host.querySelectorAll('[data-format-row] [data-row-key]')].map((b) =>
      b.getAttribute('data-row-key'),
    );

  const selectionChange = (): void => {
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
  };

  it('order: close, B I U S, link, numbered, bullet, send; no Aa, no Quote, mic hidden', () => {
    const host = mount(<PhoneHarness initial="Three hooks" />);
    act(() => (byLabel(host, 'Message') as HTMLTextAreaElement).focus());
    act(() => byLabel(host, 'Aa')?.click());
    expect(keysOf(host)).toEqual([
      'close',
      'bold',
      'italic',
      'underline',
      'strike',
      'link',
      'ol',
      'ul',
    ]);
    expect(q(host, '[data-format-row] [data-row-key="aa"]')).toBeNull();
    expect(byLabel(host, 'Quote')).toBeNull();
    expect(q(host, '[data-testid="mic"]')).toBeNull();
    // Send stays in its one trailing slot (never remounted, so its submit
    // lands) and closes the row; the keys spread between X and send.
    const row = q(host, '[data-format-row]');
    expect(row?.querySelector('[data-testid="send"]')).toBeNull();
    expect(q(host, '[data-row-trailing] [data-testid="send"]')).not.toBeNull();
    expect(q(host, '[data-row-trailing] [data-testid="mic"]')).toBeNull();
    expect(row?.nextElementSibling?.hasAttribute('data-row-trailing')).toBe(true);
    expect(row?.className).toContain('justify-between');
    // X close closes the row; the mic is back beside send.
    act(() => byLabel(host, 'Close formatting')?.click());
    expect(q(host, '[data-format-row]')).toBeNull();
    expect(q(host, '[data-row-trailing] [data-testid="mic"]')).not.toBeNull();
  });

  it('X close is a filled circle matching send (bg-accent, text-accent-fg)', () => {
    const host = mount(<PhoneHarness initial="hi" />);
    act(() => (byLabel(host, 'Message') as HTMLTextAreaElement).focus());
    act(() => byLabel(host, 'Aa')?.click());
    const close = q(host, '[data-row-key="close"]');
    expect(close?.getAttribute('aria-label')).toBe('Close formatting');
    expect(close?.className).toContain('h-11 w-9');
    expect(close?.querySelector('span')?.className).toContain('bg-accent text-accent-fg');
  });

  it('an on key has no background, border or ring classes; rest keys share fg-2', () => {
    const host = mount(<PhoneHarness initial="*hi* there" />);
    const area = byLabel(host, 'Message') as HTMLTextAreaElement;
    act(() => {
      area.focus();
      area.setSelectionRange(2, 2);
    });
    act(() => byLabel(host, 'Aa')?.click());
    const bold = q(host, '[data-row-key="bold"]');
    expect(bold?.getAttribute('aria-pressed')).toBe('true');
    const face = bold?.querySelector('span')?.className ?? '';
    expect(face).toMatch(/\btext-fg\b/);
    expect(face).not.toMatch(/\bbg-|lit-selected|\bborder\b|\bring\b/);
    for (const key of ['italic', 'underline', 'strike', 'link', 'ol', 'ul']) {
      expect(q(host, `[data-row-key="${key}"] span`)?.className).toMatch(/\btext-fg-2\b/);
    }
  });

  it('selecting text opens the row; collapsing the selection closes it', () => {
    const host = mount(<PhoneHarness initial="Three hooks" />);
    const area = byLabel(host, 'Message') as HTMLTextAreaElement;
    act(() => area.focus());
    expect(q(host, '[data-format-row]')).toBeNull();
    act(() => area.setSelectionRange(0, 5));
    selectionChange();
    expect(q(host, '[data-format-row]')).not.toBeNull();
    act(() => area.setSelectionRange(5, 5));
    selectionChange();
    expect(q(host, '[data-format-row]')).toBeNull();
  });

  it('opened with Aa, the row stays when the selection collapses, until X', () => {
    const host = mount(<PhoneHarness initial="Three hooks" />);
    const area = byLabel(host, 'Message') as HTMLTextAreaElement;
    act(() => area.focus());
    act(() => byLabel(host, 'Aa')?.click());
    act(() => area.setSelectionRange(0, 5));
    selectionChange();
    act(() => area.setSelectionRange(5, 5));
    selectionChange();
    expect(q(host, '[data-format-row]')).not.toBeNull();
    act(() => byLabel(host, 'Close formatting')?.click());
    expect(q(host, '[data-format-row]')).toBeNull();
  });

  it('comment mode on a phone shares the row; caption never formats', () => {
    const host = mount(<PhoneHarness mode="comment" initial="hi" />);
    act(() => (byLabel(host, 'Message') as HTMLTextAreaElement).focus());
    act(() => byLabel(host, 'Aa')?.click());
    expect(keysOf(host)[0]).toBe('close');
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = '';
    const cap = mount(<PhoneHarness mode="caption" initial="hi" />);
    const area = byLabel(cap, 'Message') as HTMLTextAreaElement;
    act(() => area.focus());
    act(() => area.setSelectionRange(0, 2));
    selectionChange();
    expect(q(cap, '[data-format-row]')).toBeNull();
    expect(byLabel(cap, 'Bold')).toBeNull();
  });

  it('laptop: a selection does not open the row (Aa only)', () => {
    const host = mount(<Harness mode="chat" laptop initial="Three hooks" />);
    const area = byLabel(host, 'Message') as HTMLTextAreaElement;
    act(() => area.focus());
    act(() => area.setSelectionRange(0, 5));
    selectionChange();
    expect(q(host, '[data-format-row]')).toBeNull();
  });
});

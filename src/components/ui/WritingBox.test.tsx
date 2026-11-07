// @vitest-environment jsdom
// ui/WritingBox: the chat pill on a phone, the card on focus / with text, the
// Aa row swap (X back), caption mode with no Aa row, field mode rows on focus,
// expand / collapse keeping the same field (no remount).
import { act, useRef, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
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

  it('Aa swaps the row for the format row; Close formatting brings it back', () => {
    const host = mount(<Harness mode="chat" initial="hi" />);
    act(() => byLabel(host, 'Aa')?.click());
    const labels = [...host.querySelectorAll('[data-format-row] [aria-label]')].map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels).toEqual([
      'Close formatting',
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
    act(() => byLabel(host, 'Close formatting')?.click());
    expect(q(host, '[data-format-row]')).toBeNull();
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
  it('phone: expands full screen with the title, keeps the field, collapses', () => {
    const host = mount(<Harness mode="comment" initial="draft" />);
    const area = byLabel(host, 'Message');
    act(() => byLabel(host, 'Expand')?.click());
    expect(q(host, '[data-writing-box]')?.dataset.expanded).toBe('phone');
    expect(host.textContent).toContain('Caption');
    expect(byLabel(host, 'Message')).toBe(area);
    act(() => (host.querySelectorAll('[aria-label="Collapse"]')[0] as HTMLElement).click());
    expect(q(host, '[data-writing-box]')?.dataset.expanded).toBeUndefined();
    expect((byLabel(host, 'Message') as HTMLTextAreaElement).value).toBe('draft');
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

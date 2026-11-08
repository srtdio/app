// @vitest-environment jsdom
// comments/MentionInput with formatting: WYSIWYG in the comment box. Styles
// show live on real spans, the markers never show, the body reported is the
// saved marker text (tokens for chips), and typed pairs hide.
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { MentionInput, readEditorText } from '@/components/comments/MentionInput';
import type { MentionInputHandle } from '@/components/comments/MentionInput';
import type { MentionCandidate } from '@/lib/workspace-members';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ADA: MentionCandidate = {
  id: '11111111-2222-3333-4444-555555555555',
  name: 'Ada Lovelace',
  username: 'ada',
  role: 'creator',
  avatarUrl: null,
};

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function mount(initialBody?: string): {
  editor: HTMLElement;
  bodies: string[];
  handle: { current: MentionInputHandle | null };
} {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const bodies: string[] = [];
  const handle = createRef<MentionInputHandle>();
  act(() =>
    root?.render(
      <MentionInput
        ref={handle}
        bare
        formatting
        members={[ADA]}
        placeholder="Add a comment"
        initialBody={initialBody}
        onChange={(b) => bodies.push(b)}
      />,
    ),
  );
  const editor = host.querySelector<HTMLElement>('[contenteditable="true"]');
  if (editor === null) throw new Error('no editor');
  return { editor, bodies, handle };
}

describe('MentionInput WYSIWYG', () => {
  it('a seeded body shows styled with no marker; the chip stays a token', () => {
    const { editor, bodies } = mount(`*hi* @[${ADA.id}] there`);
    expect(editor.textContent).not.toContain('*');
    const span = editor.querySelector('[data-live-style]');
    expect(span?.textContent).toBe('hi');
    expect(span?.className).toContain('[-webkit-text-stroke:0.035em_currentColor]');
    expect(editor.querySelector('[data-mention-id]')?.textContent).toBe('@ada');
    expect(bodies[bodies.length - 1]).toBe(`*hi* @[${ADA.id}] there`);
  });

  it('typing a pair hides its markers and draws the style', () => {
    const { editor, bodies } = mount();
    act(() => {
      editor.textContent = 'a _b_ c';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(bodies[bodies.length - 1]).toBe('a _b_ c');
    expect(editor.textContent).not.toContain('_');
    const span = editor.querySelector('[data-live-style]');
    expect(span?.textContent).toBe('b');
    expect(span?.className).toContain('italic');
  });

  it('combined styles land on one span', () => {
    const { editor } = mount('*~+x+~* y');
    const span = editor.querySelector('[data-live-style]');
    expect(span?.textContent).toBe('x');
    expect(span?.className).toContain('[text-decoration-line:underline_line-through]');
    expect(span?.className).toContain('[-webkit-text-stroke:0.035em_currentColor]');
  });

  it('insertText (emoji) keeps the saved text and the styles', () => {
    const { editor, bodies, handle } = mount('*ok*');
    act(() => handle.current?.insertText(' 🔥'));
    expect(bodies[bodies.length - 1]).toBe('*ok* 🔥');
    expect(readEditorText(editor)).toHaveLength('*ok* 🔥'.length);
  });
});

// @vitest-environment jsdom
// The comment composer on ui/WritingBox (comment mode): the card always; at
// rest the text line and the round Send; focused or holding a draft, the row
// under the text: + , Aa, emoji, @ (only with members) ... the round Send
// (RowSend). No mic, no laptop emoji popover. Sending keeps the box (the
// spinner sits in the send); the field look is the box's, never the editor's.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => true,
  useHoverPointer: () => true,
}));

import { CommentComposer, type CommentSubmitResult } from '@/components/comments/CommentComposer';
import type { MentionCandidate } from '@/lib/workspace-members';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return host?.querySelector<T>(sel) ?? null;
}

function byLabel(label: string): HTMLButtonElement | null {
  return q<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

const ANA: MentionCandidate = {
  id: 'u-ana',
  name: 'Ana',
  username: 'ana',
  role: 'approver',
  avatarUrl: null,
};

function mount(
  onSubmit: (
    body: string,
    options: { attachmentVersionIds: string[] },
  ) => Promise<CommentSubmitResult> = async () => ({ ok: true }),
  extra: {
    submitLabel?: string;
    placeholder?: string;
    submitAnchor?: string;
    initialBody?: string | null;
    members?: MentionCandidate[];
  } = {},
): void {
  const initialBody = extra.initialBody === undefined ? 'Looks good' : extra.initialBody;
  act(() => {
    root?.render(
      <CommentComposer
        onSubmit={onSubmit}
        members={extra.members ?? []}
        canAttach
        uploadFile={async () => ({ ok: true, reused: false, versionId: 'ver-1' })}
        {...(initialBody !== null ? { initialBody } : {})}
        placeholder={extra.placeholder ?? 'Write a comment'}
        expandTitle="Spring drop"
        {...(extra.submitLabel !== undefined ? { submitLabel: extra.submitLabel } : {})}
        {...(extra.submitAnchor !== undefined ? { submitAnchor: extra.submitAnchor } : {})}
      />,
    );
  });
}

/** The row's controls in order: each button's name, then 'send:<name>'. */
function rowOrder(): string[] {
  const row = q('[data-writing-row]');
  if (row === null) return [];
  return Array.from(row.querySelectorAll<HTMLButtonElement>('button')).map((b) =>
    b.hasAttribute('data-row-send')
      ? `send:${b.getAttribute('aria-label') ?? ''}`
      : (b.getAttribute('aria-label') ?? ''),
  );
}

describe('CommentComposer on ui/WritingBox', () => {
  it('renders the WritingBox in comment mode', async () => {
    mount();
    await settle();
    const box = q('[data-writing-box]');
    expect(box).not.toBeNull();
    expect(box?.getAttribute('data-mode')).toBe('comment');
  });

  it('holding a draft: the card, text on top, then + Aa Emoji @ ... the round Send', async () => {
    mount();
    await settle();
    expect(q('[data-writing-box]')?.dataset.shape).toBe('card');
    expect(q('[data-writing-field] [contenteditable="true"]')).not.toBeNull();
    // @ always (the people list opens above the box, as in chat); no mic, no
    // paper clip.
    expect(rowOrder()).toEqual(['Add attachment', 'Aa', 'Emoji', 'Mention', 'send:Post']);
    expect(byLabel('Record voice note')).toBeNull();
    expect(byLabel('Attach a file')).toBeNull();
    // The + is ComposerTray's compact key (its 36 grey circle).
    expect(byLabel('Add attachment')?.hasAttribute('data-plus')).toBe(true);
  });

  it('Send is RowSend: solid ink, sendable or not (nothing to send: no tap)', async () => {
    mount();
    await settle();
    const send = byLabel('Post');
    expect(send?.hasAttribute('data-row-send')).toBe(true);
    expect(send?.disabled).toBe(false);
    expect(send?.querySelector('span')?.className).toContain('bg-accent');

    act(() => root?.unmount());
    root = createRoot(host as HTMLDivElement);
    mount(undefined, { initialBody: null });
    await settle();
    const empty = byLabel('Post');
    expect(empty?.disabled).toBe(true);
    expect(empty?.querySelector('span')?.className).toContain('bg-accent');
    expect(empty?.querySelector('span')?.className).not.toContain('bg-panel-3');
  });

  it('at rest (empty, unfocused): the text line with its + and Send; focus shows the row', async () => {
    mount(undefined, { initialBody: null, members: [ANA] });
    await settle();
    expect(q('[data-writing-box]')?.dataset.shape).toBe('line');
    expect(byLabel('Aa')).toBeNull();
    // The + stays beside the field at rest (it attaches today).
    expect(byLabel('Add attachment')).not.toBeNull();
    expect(byLabel('Post')).not.toBeNull();

    const editor = q('[contenteditable="true"]');
    act(() => {
      editor?.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    });
    expect(q('[data-writing-box]')?.dataset.shape).toBe('card');
    expect(rowOrder()).toEqual(['Add attachment', 'Aa', 'Emoji', 'Mention', 'send:Post']);
  });

  it("the field look is the box's: the editor draws no line, well or focus line", async () => {
    mount();
    await settle();
    const editor = q('[contenteditable="true"]');
    expect(editor?.className).not.toContain('border-field');
    expect(editor?.className).not.toContain('lit-well');
    expect(editor?.className).not.toContain('focus:lit-focus');
    expect(editor?.getAttribute('aria-label')).toBe('Comment body');
    // The focus line draws inside the edge, so no parent can cut it.
    expect(q('[data-writing-frame]')?.className).toContain('focus-within:lit-focus-inset');
  });

  it('keeps its hint and the guide anchor on Send', async () => {
    mount(undefined, { placeholder: 'Write a reply', submitLabel: 'Reply', submitAnchor: 'x-key' });
    await settle();
    expect(q('[contenteditable="true"]')?.getAttribute('data-placeholder')).toBe('Write a reply');
    expect(byLabel('Reply')?.getAttribute('data-induction')).toBe('x-key');
  });

  it('sending keeps the box: the spinner sits in the send, the field stays', async () => {
    let resolve: (r: CommentSubmitResult) => void = () => undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<CommentSubmitResult>((r) => {
          resolve = r;
        }),
    );
    mount(onSubmit);
    await settle();
    const before = q('[data-writing-frame]');

    await act(async () => {
      byLabel('Post')?.click();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(q('[data-writing-box]')?.getAttribute('data-composer-state')).toBe('sending');
    expect(q('[data-writing-frame]')).toBe(before);
    expect(q('[data-writing-field] [contenteditable="true"]')).not.toBeNull();
    const send = byLabel('Post');
    expect(send?.getAttribute('aria-busy')).toBe('true');
    expect(send?.querySelector('[data-upload-arc]')).not.toBeNull();

    await act(async () => {
      resolve({ ok: true });
    });
    await settle();
    expect(q('[data-writing-box]')?.getAttribute('data-composer-state')).toBe('idle');
  });

  it('chips and errors sit under the box, never inside it', async () => {
    mount(async () => ({ ok: false, error: "Couldn't post the comment. Try again." }));
    await settle();
    await act(async () => {
      byLabel('Post')?.click();
    });
    await settle();
    const alert = q('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(q('[data-writing-box]')?.contains(alert)).toBe(false);
  });
});

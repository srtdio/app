// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommentComposer, type CommentSubmitResult } from '@/components/comments/CommentComposer';

// A submit the parent already explained with a toast (comment_create's
// invalid_mention) keeps the whole draft: the typed text and the attached
// files stay, and nothing is shown inline under the composer.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLIENT = '33333333-3333-4333-8333-333333333333';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

function editorText(): string {
  return host?.querySelector('[contenteditable="true"]')?.textContent ?? '';
}

function postButton(): HTMLButtonElement | undefined {
  return Array.from(host?.querySelectorAll('button') ?? []).find(
    (b) => b.textContent?.trim() === 'Post',
  );
}

async function attach(file: File): Promise<void> {
  const input = host?.querySelector<HTMLInputElement>('input[type="file"]');
  if (input == null) throw new Error('no file input');
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

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

describe('CommentComposer after a toasted failure', () => {
  it('keeps the typed text and the attachment chips, with no inline alert', async () => {
    const onSubmit = vi.fn<
      (body: string, options: { attachmentVersionIds: string[] }) => Promise<CommentSubmitResult>
    >(async () => ({ ok: false, notified: true }));
    act(() => {
      root?.render(
        <CommentComposer
          onSubmit={onSubmit}
          members={[
            { id: CLIENT, name: 'Cara Client', username: 'cara', role: 'client', avatarUrl: null },
          ]}
          canAttach
          uploadFile={async () => ({ ok: true, reused: false, versionId: 'ver-1' })}
          initialBody="Please check the caption"
        />,
      );
    });
    await settle();
    await attach(new File(['%PDF-1.4'], 'brief.pdf', { type: 'application/pdf' }));

    expect(editorText()).toBe('Please check the caption');
    expect(host?.textContent).toContain('brief.pdf');

    await act(async () => {
      postButton()?.click();
    });
    await settle();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toBe('Please check the caption');
    expect(onSubmit.mock.calls[0]?.[1]).toEqual({ attachmentVersionIds: ['ver-1'] });
    // The draft is intact: same text, same chip, the Post button usable again.
    expect(editorText()).toBe('Please check the caption');
    expect(host?.textContent).toContain('brief.pdf');
    expect(postButton()?.disabled).toBe(false);
    expect(host?.querySelector('[role="alert"]')).toBeNull();
  });

  it('still shows the inline error for an ordinary failure, draft kept', async () => {
    act(() => {
      root?.render(
        <CommentComposer
          onSubmit={async () => ({ ok: false, error: "Couldn't post the comment. Try again." })}
          members={[]}
          canAttach={false}
          initialBody="Hello"
        />,
      );
    });
    await settle();
    await act(async () => {
      postButton()?.click();
    });
    await settle();

    expect(editorText()).toBe('Hello');
    expect(host?.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't post the comment. Try again.",
    );
  });
});

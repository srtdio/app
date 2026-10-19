// @vitest-environment jsdom
// X4 (FT48): the Undo failure toast reads "Couldn't {verb}. Try again.",
// built correctly (never "Couldn't task deleted"); a caller may pass its own
// failure message (task delete: "Couldn't delete the task. Try again.");
// callers without one keep working.
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToastOptions } from '@/components/ui/toast/types';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const shown: ToastOptions[] = [];
vi.mock('@/components/ui/toast', () => ({
  useOptionalToast: () => ({
    show: (options: ToastOptions) => {
      shown.push(options);
      return String(shown.length);
    },
    dismiss: vi.fn(),
  }),
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { undoFailureTitle, useUndoableAction } from '@/lib/use-undoable-action';
import { TASK_DELETE_FAILED, TASK_DELETED_LABEL } from '@/components/chat/tasks/useChatTasks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let api: ReturnType<typeof useUndoableAction> | null = null;

function Probe(): ReactElement {
  api = useUndoableAction();
  return <div />;
}

beforeEach(async () => {
  shown.length = 0;
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Probe />));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  api = null;
  document.body.innerHTML = '';
});

describe('X4 Undo failure copy', () => {
  it('a done-label becomes its verb, never "Couldn\'t task deleted"', () => {
    expect(undoFailureTitle('Task deleted')).toBe("Couldn't delete the task. Try again.");
    expect(undoFailureTitle('Task deleted')).not.toContain('task deleted');
    expect(undoFailureTitle('Comment deleted')).toBe("Couldn't delete the comment. Try again.");
    expect(undoFailureTitle('3 files deleted')).toBe("Couldn't delete 3 files. Try again.");
    expect(undoFailureTitle('Moved to Review')).toBe("Couldn't move to Review. Try again.");
    expect(undoFailureTitle('Marked as read')).toBe("Couldn't mark as read. Try again.");
  });

  it('an imperative label reads as before', () => {
    expect(undoFailureTitle('Delete post')).toBe("Couldn't delete post. Try again.");
    expect(undoFailureTitle('Archive Brief')).toBe("Couldn't archive brief. Try again.");
  });

  it("a caller's own failure message wins; the task delete passes one", async () => {
    expect(TASK_DELETE_FAILED).toBe("Couldn't delete the task. Try again.");
    act(() =>
      api?.run({
        label: TASK_DELETED_LABEL,
        failure: TASK_DELETE_FAILED,
        commit: async () => {
          throw new Error('rpc 500');
        },
      }),
    );
    const undo = shown[shown.length - 1];
    undo?.onExpire?.();
    await act(async () => {});
    expect(shown[shown.length - 1]?.title).toBe(TASK_DELETE_FAILED);
  });

  it('without one, the default copy is used', async () => {
    act(() =>
      api?.run({
        label: 'Post deleted',
        commit: async () => {
          throw new Error('boom');
        },
      }),
    );
    shown[shown.length - 1]?.onExpire?.();
    await act(async () => {});
    expect(shown[shown.length - 1]?.title).toBe("Couldn't delete the post. Try again.");
  });
});

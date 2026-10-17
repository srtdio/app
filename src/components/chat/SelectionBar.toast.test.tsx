// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockShow } = vi.hoisted(() => ({ mockShow: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ show: mockShow }) }));

import { SelectionBar } from '@/components/chat/SelectionBar';
import { FILES_DELETED_TOAST } from '@/lib/chat/delete-flow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  mockShow.mockReset();
});

// The confirm's own button: the last "Delete" (the bar's comes first).
function confirmButton(): HTMLButtonElement {
  return [...document.querySelectorAll('button')]
    .filter((b) => b.textContent?.trim() === 'Delete')
    .at(-1)!;
}

async function runDelete(result: { ok: true; toast?: string }): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <SelectionBar
        count={1}
        block={null}
        canDelete
        confirmCopy={null}
        onDelete={() => Promise.resolve(result)}
      />,
    ),
  );
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[data-selection-delete]')!.click(),
  );
  await act(async () => confirmButton().click());
}

describe('SelectionBar delete toast', () => {
  it('shows the files toast when the delete carried files', async () => {
    await runDelete({ ok: true, toast: FILES_DELETED_TOAST });
    expect(mockShow).toHaveBeenCalledWith({ title: 'Deleted. File removed for good.' });
  });

  it('shows nothing for a text-only delete', async () => {
    await runDelete({ ok: true });
    expect(mockShow).not.toHaveBeenCalled();
  });
});

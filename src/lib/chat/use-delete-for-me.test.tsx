import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { ToastOptions } from '@/components/ui/toast/types';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

vi.mock('@/lib/device-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/device-cache')>();
  return { ...actual, put: vi.fn() };
});

// The write goes through the app client; a fake rpc stands in for it. The
// repo's vitest has no DOM renderer: a fake toast surface captures what
// useUndoableAction shows, so the test can press Undo or let the window end.
const fakes = vi.hoisted(() => {
  const shown: ToastOptions[] = [];
  return {
    rpc: vi.fn(),
    shown,
    toastApi: {
      show: (options: ToastOptions): string => {
        shown.push(options);
        return `t${shown.length}`;
      },
      dismiss: (): void => undefined,
    },
  };
});
const { rpc, shown } = fakes;

vi.mock('@/lib/supabase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase')>();
  return { ...actual, supabase: { rpc: (...args: unknown[]) => fakes.rpc(...args) } };
});

vi.mock('@/components/ui/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/toast')>();
  return {
    ...actual,
    useOptionalToast: () => fakes.toastApi,
    useToast: () => fakes.toastApi,
  };
});

import {
  deleteForMeFailure,
  deletedForYouLabel,
  useDeleteForMe,
  type HideItem,
} from '@/lib/chat/use-delete-for-me';
import { hiddenIdsFor, resetHides } from '@/lib/chat/hides';

const WS = 'ws-1';

/** Render the hook once (server render) and hand back its run. */
function hookRun(input: {
  userId: string | null;
  workspaceId: string | null;
}): (items: readonly HideItem[]) => void {
  const held: { run?: (items: readonly HideItem[]) => void } = {};
  function Harness(): ReactElement | null {
    held.run = useDeleteForMe(input);
    return null;
  }
  renderToStaticMarkup(<Harness />);
  const run = held.run;
  if (run === undefined) throw new Error('hook did not render');
  return run;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  shown.length = 0;
  rpc.mockReset();
});

afterEach(() => {
  resetHides();
});

describe('Delete for me copy', () => {
  it('"Deleted for you" for one, "N deleted for you" for several', () => {
    expect(deletedForYouLabel(1)).toBe('Deleted for you');
    expect(deletedForYouLabel(3)).toBe('3 deleted for you');
  });

  it('the failure line follows "Couldn\'t {action}."', () => {
    expect(deleteForMeFailure(1, new Error('x'))).toMatch(/^Couldn't delete the message\./);
    expect(deleteForMeFailure(4, new Error('x'))).toMatch(/^Couldn't delete 4 messages\./);
  });
});

describe('useDeleteForMe', () => {
  const items: HideItem[] = [
    { messageId: 'm1', channelId: 'c1' },
    { messageId: 'm2', channelId: 'c1' },
  ];

  it('hides at once, shows the Undo strip and writes nothing yet', () => {
    const run = hookRun({ userId: 'u1', workspaceId: WS });
    run(items);
    expect([...hiddenIdsFor(WS)].sort()).toEqual(['m1', 'm2']);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe('2 deleted for you');
    expect(shown[0]?.kind).toBe('undo');
    expect(shown[0]?.action?.label).toBe('Undo');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('Undo shows them again and never writes', async () => {
    const run = hookRun({ userId: 'u1', workspaceId: WS });
    run(items);
    shown[0]?.action?.onPress();
    await flush();
    expect(hiddenIdsFor(WS).size).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('when the window ends, writes chat_messages_hide with one trace id', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const run = hookRun({ userId: 'u1', workspaceId: WS });
    run(items);
    shown[0]?.onExpire?.();
    await flush();
    expect(rpc).toHaveBeenCalledTimes(1);
    const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('chat_messages_hide');
    expect(args.p_message_ids).toEqual(['m1', 'm2']);
    expect(typeof args.p_trace_id).toBe('string');
    expect(String(args.p_trace_id)).not.toBe('');
    expect([...hiddenIdsFor(WS)].sort()).toEqual(['m1', 'm2']);
  });

  it('a failed write shows them again and toasts the failure', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'refused' } });
    const run = hookRun({ userId: 'u1', workspaceId: WS });
    run([{ messageId: 'm1', channelId: 'c1' }]);
    expect(hiddenIdsFor(WS).has('m1')).toBe(true);
    shown[0]?.onExpire?.();
    await flush();
    await flush();
    expect(hiddenIdsFor(WS).has('m1')).toBe(false);
    const failure = shown[1];
    expect(failure?.tone).toBe('error');
    expect(failure?.title).toMatch(/^Couldn't delete the message\./);
  });

  it('is a no-op without a user, a workspace or items', () => {
    hookRun({ userId: null, workspaceId: WS })(items);
    hookRun({ userId: 'u1', workspaceId: null })(items);
    hookRun({ userId: 'u1', workspaceId: WS })([]);
    expect(hiddenIdsFor(WS).size).toBe(0);
    expect(shown).toHaveLength(0);
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A controllable proc_capability: each call returns a deferred the test settles,
// so a read that lands after a user switch is observable.
interface Deferred {
  args: { p_workspace_id: string; p_capability: string };
  resolve: (value: { data: unknown; error: { message: string } | null }) => void;
}
const { calls, who } = vi.hoisted(() => ({
  calls: [] as Deferred[],
  who: { userId: null as string | null, workspaceId: 'ws-1' as string | null },
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (_name: string, args: Deferred['args']) =>
      new Promise((resolve) => {
        calls.push({ args, resolve });
      }),
  },
}));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: who.userId === null ? null : { user: { id: who.userId } } }),
}));
vi.mock('@/lib/workspace-context', () => ({
  useWorkspace: () => ({ workspaceId: who.workspaceId }),
}));

import { SIGNOUT_EVENT } from '@/lib/events';
import {
  capabilityKey,
  clearCapabilityCache,
  useWorkspaceCapability,
} from '@/lib/workspace-context-capability';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const seen: (boolean | null)[] = [];

function Probe() {
  seen.push(useWorkspaceCapability('brief.create'));
  return null;
}

function render(): void {
  act(() => {
    if (host === null) {
      host = document.createElement('div');
      document.body.appendChild(host);
    }
    root ??= createRoot(host);
    root.render(<Probe />);
  });
}

function last(): boolean | null | undefined {
  return seen[seen.length - 1];
}

async function settle(index: number, data: unknown): Promise<void> {
  await act(async () => {
    calls[index]?.resolve({ data, error: null });
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  calls.length = 0;
  seen.length = 0;
  who.userId = null;
  who.workspaceId = 'ws-1';
  clearCapabilityCache();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('capabilityKey', () => {
  it('needs a user and a workspace', () => {
    expect(capabilityKey(null, 'ws-1', 'brief.create')).toBeNull();
    expect(capabilityKey('', 'ws-1', 'brief.create')).toBeNull();
    expect(capabilityKey('u-a', null, 'brief.create')).toBeNull();
  });

  it('differs per user, workspace and capability', () => {
    const a = capabilityKey('u-a', 'ws-1', 'brief.create');
    expect(a).not.toBe(capabilityKey('u-b', 'ws-1', 'brief.create'));
    expect(a).not.toBe(capabilityKey('u-a', 'ws-2', 'brief.create'));
    expect(a).not.toBe(capabilityKey('u-a', 'ws-1', 'post.create'));
  });
});

describe('useWorkspaceCapability', () => {
  it('reads nothing and returns null with no signed-in user', () => {
    render();
    expect(calls).toHaveLength(0);
    expect(last()).toBeNull();
  });

  it("never serves user A's answer to user B on the same device", async () => {
    who.userId = 'u-a';
    render();
    expect(calls).toHaveLength(1);
    await settle(0, true);
    expect(last()).toBe(true);

    // Same device, same workspace, a different person.
    who.userId = 'u-b';
    seen.length = 0;
    render();
    expect(calls).toHaveLength(2);
    expect(seen.every((v) => v === null)).toBe(true);

    await settle(1, false);
    expect(last()).toBe(false);
  });

  it("drops user A's read that lands after the switch to user B", async () => {
    who.userId = 'u-a';
    render();
    expect(calls).toHaveLength(1);

    who.userId = 'u-b';
    seen.length = 0;
    render();
    expect(calls).toHaveLength(2);

    // A's read lands late with true: B still sees null, and the cache holds nothing for B.
    await settle(0, true);
    expect(seen.every((v) => v === null)).toBe(true);

    await settle(1, false);
    expect(last()).toBe(false);
  });

  it('serves a cached answer to the same user without a second read', async () => {
    who.userId = 'u-a';
    render();
    await settle(0, true);
    act(() => root?.unmount());
    root = null;
    render();
    expect(calls).toHaveLength(1);
    expect(last()).toBe(true);
  });

  it('signout clears the cache: the next mount reads again', async () => {
    who.userId = 'u-a';
    render();
    await settle(0, true);
    act(() => root?.unmount());
    root = null;

    act(() => {
      window.dispatchEvent(new CustomEvent(SIGNOUT_EVENT));
    });
    render();
    expect(calls).toHaveLength(2);
    expect(last()).toBeNull();
  });

  it('a read in flight at signout is never cached', async () => {
    who.userId = 'u-a';
    render();
    act(() => {
      window.dispatchEvent(new CustomEvent(SIGNOUT_EVENT));
    });
    await settle(0, true);
    act(() => root?.unmount());
    root = null;
    render();
    // The late answer was not stored: a fresh read goes out.
    expect(calls).toHaveLength(2);
  });
});

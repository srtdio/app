// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A controllable capabilities_for_workspace: each call returns a deferred the
// test settles, so a read that lands after a user switch is observable.
interface Deferred {
  name: string;
  args: { p_trace_id: string; p_workspace_id: string };
  resolve: (value: { data: unknown; error: { message: string } | null }) => void;
}
const { calls, who } = vi.hoisted(() => ({
  calls: [] as Deferred[],
  who: { userId: null as string | null, workspaceId: 'ws-1' as string | null },
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (name: string, args: Deferred['args']) =>
      new Promise((resolve) => {
        calls.push({ name, args, resolve });
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
  mapCapabilityRows,
  readWorkspaceCapability,
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

// Two buttons on one screen asking the same capability.
function Pair() {
  seen.push(useWorkspaceCapability('brief.create'));
  seen.push(useWorkspaceCapability('brief.create'));
  return null;
}

function renderPair(): void {
  act(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(<Pair />);
  });
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

function rows(briefCreate: boolean): { capability: string; allowed: boolean }[] {
  return [
    { capability: 'brief.create', allowed: briefCreate },
    { capability: 'post.create', allowed: true },
  ];
}

function last(): boolean | null | undefined {
  return seen[seen.length - 1];
}

// Settle read `index` with brief.create allowed (true) or not (false).
async function settle(index: number, briefCreate: boolean): Promise<void> {
  await act(async () => {
    calls[index]?.resolve({ data: rows(briefCreate), error: null });
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

  it('two hooks asking the same capability at once share one rpc', async () => {
    who.userId = 'u-a';
    renderPair();
    expect(calls).toHaveLength(1);
    await settle(0, true);
    expect(seen.slice(-2)).toEqual([true, true]);
    expect(calls).toHaveLength(1);
  });

  it('never renders allowed then hides: null until known, then the answer only', async () => {
    who.userId = 'u-a';
    renderPair();
    await settle(0, false);
    // Every render before the answer is null (hidden); after it, false. Never true.
    expect(seen).not.toContain(true);
    const firstFalse = seen.indexOf(false);
    expect(firstFalse).toBeGreaterThan(0);
    expect(seen.slice(0, firstFalse).every((v) => v === null)).toBe(true);
    expect(seen.slice(firstFalse).every((v) => v === false)).toBe(true);
  });

  it('a failed read stays hidden and is not cached: the next mount retries', async () => {
    who.userId = 'u-a';
    render();
    await act(async () => {
      calls[0]?.resolve({ data: null, error: { message: 'boom' } });
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    });
    expect(last()).toBeNull();
    act(() => root?.unmount());
    root = null;
    render();
    expect(calls).toHaveLength(2);
  });
});

describe('one capabilities_for_workspace read per workspace', () => {
  // Five capability checks on one page (BriefDetailPage asks four, the shell one).
  function Page() {
    seen.push(useWorkspaceCapability('brief.create'));
    seen.push(useWorkspaceCapability('brief.close'));
    seen.push(useWorkspaceCapability('brief.close_own'));
    seen.push(useWorkspaceCapability('post.create'));
    seen.push(useWorkspaceCapability('workspace.manage_settings'));
    return null;
  }

  it('every check on a page reads from one rpc with an explicit trace id', async () => {
    who.userId = 'u-a';
    act(() => {
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      root.render(<Page />);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('capabilities_for_workspace');
    expect(calls[0]?.args.p_workspace_id).toBe('ws-1');
    expect(calls[0]?.args.p_trace_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(calls[0]?.args ?? {}).sort()).toEqual(['p_trace_id', 'p_workspace_id']);
    await settle(0, true);
    // brief.create and post.create allowed; the three it does not name are false.
    expect(seen.slice(-5)).toEqual([true, false, false, true, false]);
    expect(calls).toHaveLength(1);
  });

  it('another workspace is its own read', async () => {
    who.userId = 'u-a';
    render();
    await settle(0, true);
    who.workspaceId = 'ws-2';
    render();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args.p_workspace_id).toBe('ws-2');
  });

  it('readWorkspaceCapability answers from the cached set without a read', async () => {
    who.userId = 'u-a';
    render();
    await settle(0, false);
    await expect(readWorkspaceCapability('u-a', 'ws-1', 'post.create')).resolves.toBe(true);
    await expect(readWorkspaceCapability('u-a', 'ws-1', 'brief.create')).resolves.toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('a failed read resolves null and is not cached: the next ask reads again', async () => {
    const first = readWorkspaceCapability('u-a', 'ws-1', 'brief.create');
    expect(calls).toHaveLength(1);
    calls[0]?.resolve({ data: null, error: { message: 'boom' } });
    await expect(first).resolves.toBeNull();
    const second = readWorkspaceCapability('u-a', 'ws-1', 'brief.create');
    expect(calls).toHaveLength(2);
    calls[1]?.resolve({ data: rows(true), error: null });
    await expect(second).resolves.toBe(true);
  });
});

describe('mapCapabilityRows', () => {
  it('keeps only allowed capabilities', () => {
    const set = mapCapabilityRows([
      { capability: 'a', allowed: true },
      { capability: 'b', allowed: false },
      { capability: 'c', allowed: null },
    ]);
    expect([...set]).toEqual(['a']);
  });

  it('reads no rows (or a bad answer) as nothing allowed', () => {
    expect(mapCapabilityRows([]).size).toBe(0);
    expect(mapCapabilityRows(null).size).toBe(0);
  });
});

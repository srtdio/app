// @vitest-environment jsdom
// X8 (FT67, FB2): the make-a-workspace dialog asks before Escape, the backdrop,
// the X or system Back drop a typed brand name or picked platform, and owns
// focus while open (useModalFocus).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { guardCalls, mockRelease } = vi.hoisted(() => ({
  guardCalls: [] as { active: boolean; onBack: () => void }[],
  mockRelease: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/env', () => ({
  env: { VITE_SUPABASE_URL: 'https://sb.test', VITE_SUPABASE_PUBLISHABLE_KEY: 'pk' },
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-x8' }));
vi.mock('@srtdio/rpc', () => ({ workspaceCreate: vi.fn() }));
vi.mock('@/components/induction/induction-data', () => ({ storeInductionStep: vi.fn() }));
// The guard's options per render: the latest says whether Back is held.
vi.mock('@/lib/back-guard', () => ({
  useBackGuard: (options: { active: boolean; onBack: () => void }) => {
    guardCalls.push(options);
    return { release: mockRelease };
  },
}));
// The support sheets are Sheets with their own Back guard: stubbed so every
// recorded guard call is the dialog's.
vi.mock('@/components/support/ContactSheet', () => ({ ContactSheet: () => null }));
vi.mock('@/components/support/BookCallSheet', () => ({ BookCallSheet: () => null }));
vi.mock('@/lib/workspace-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace-context')>();
  return {
    ...actual,
    useWorkspace: () => ({
      workspaceId: null,
      workspaces: [],
      loading: false,
      error: null,
      setActiveWorkspaceId: vi.fn(),
      refreshWorkspaces: vi.fn(async () => {}),
      createBlocked: false,
      workspaceDisplayName: null,
      deletedWorkspace: null,
      clearDeletedWorkspace: vi.fn(),
    }),
  };
});

import { createStepDirty, WorkspaceSwitcher } from '@/components/shell/WorkspaceSwitcher';
import { WORKSPACE_CREATE_COPY } from '@/lib/induction-copy';
import { DUR_BASE_MS } from '@/lib/motion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let opener: HTMLButtonElement | null = null;

async function mount(): Promise<void> {
  opener = document.createElement('button');
  opener.textContent = 'Make a workspace';
  document.body.appendChild(opener);
  opener.focus();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<WorkspaceSwitcher />));
  await act(async () => {
    window.dispatchEvent(new CustomEvent('sorted:switch-workspace'));
  });
}

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"][aria-label="Create workspace"]');
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
}

async function typeName(value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('#workspace-name')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function escape(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

async function clickBackdrop(): Promise<void> {
  const overlay = dialog()?.parentElement?.querySelector<HTMLButtonElement>('[data-backdrop]');
  if (overlay == null) throw new Error('no backdrop');
  await act(async () => overlay.click());
}

function latestGuard(): { active: boolean; onBack: () => void } {
  const last = guardCalls[guardCalls.length - 1];
  if (last === undefined) throw new Error('no guard');
  return last;
}

beforeEach(async () => {
  guardCalls.length = 0;
  mockRelease.mockClear();
  await mount();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('X8 createStepDirty', () => {
  it('is dirty only on the create steps with a name or a platform', () => {
    expect(createStepDirty({ mode: 'create', name: '', platform: null })).toBe(false);
    expect(createStepDirty({ mode: 'create', name: '   ', platform: null })).toBe(false);
    expect(createStepDirty({ mode: 'create', name: 'Kite', platform: null })).toBe(true);
    expect(createStepDirty({ mode: 'create', name: '', platform: 'instagram' })).toBe(true);
    expect(createStepDirty({ mode: 'confirm', name: 'Kite', platform: 'instagram' })).toBe(true);
    expect(createStepDirty({ mode: 'list', name: 'Kite', platform: 'instagram' })).toBe(false);
  });
});

describe('X8 make-a-workspace discard ask', () => {
  it('Escape on an empty form closes at once', async () => {
    await escape();
    expect(dialog()).toBeNull();
  });

  it('Escape with a typed brand name asks first, and Keep editing keeps it', async () => {
    await typeName('Kite');
    await escape();
    expect(dialog()).not.toBeNull();
    expect(document.body.textContent).toContain(WORKSPACE_CREATE_COPY.discardTitle);
    await act(async () => findButton(WORKSPACE_CREATE_COPY.keepEditing)!.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, DUR_BASE_MS + 30));
    });
    expect(document.body.textContent).not.toContain(WORKSPACE_CREATE_COPY.discardTitle);
    expect(document.querySelector<HTMLInputElement>('#workspace-name')!.value).toBe('Kite');
  });

  it('the backdrop with a picked platform asks first, and Discard closes', async () => {
    await act(async () => document.querySelector<HTMLButtonElement>('[role="radio"]')!.click());
    await clickBackdrop();
    expect(document.body.textContent).toContain(WORKSPACE_CREATE_COPY.discardTitle);
    await act(async () => findButton(WORKSPACE_CREATE_COPY.discardConfirm)!.click());
    expect(mockRelease).toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('holds system Back only while there is something to lose, and Back asks', async () => {
    expect(latestGuard().active).toBe(false);
    await typeName('Kite');
    expect(latestGuard().active).toBe(true);
    await act(async () => latestGuard().onBack());
    expect(dialog()).not.toBeNull();
    expect(document.body.textContent).toContain(WORKSPACE_CREATE_COPY.discardTitle);
  });
});

describe('X8 make-a-workspace focus (useModalFocus)', () => {
  it('moves focus into the dialog on open, onto the brand name', () => {
    expect(document.activeElement?.id).toBe('workspace-name');
  });

  it('hands focus back to the opener on close', async () => {
    await escape();
    expect(document.activeElement).toBe(opener);
  });
});

// @vitest-environment jsdom
// X8: a self-signed-up Creator still in the no-workspace shell can say "I
// approve posts instead" on the make-a-workspace dialog, which stores the
// approver's brand step and lands them on the brand screen.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockStore, mockState } = vi.hoisted(() => ({
  mockStore: vi.fn(),
  mockState: {
    workspaces: [] as { id: string; name: string; platform: string }[],
  },
}));

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/env', () => ({
  env: { VITE_SUPABASE_URL: 'https://sb.test', VITE_SUPABASE_PUBLISHABLE_KEY: 'pk' },
}));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-x8' }));
vi.mock('@srtdio/rpc', () => ({ workspaceCreate: vi.fn() }));
vi.mock('@/components/induction/induction-data', () => ({ storeInductionStep: mockStore }));
vi.mock('@/lib/workspace-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace-context')>();
  return {
    ...actual,
    useWorkspace: () => ({
      workspaceId: mockState.workspaces[0]?.id ?? null,
      workspaces: mockState.workspaces,
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

import { approverSwitchShown, WorkspaceSwitcher } from '@/components/shell/WorkspaceSwitcher';
import { APPROVER_BRAND_STEP, approverStageOf, WORKSPACE_STEP } from '@/lib/induction';
import { WORKSPACE_CREATE_COPY } from '@/lib/induction-copy';
import { ROUTE_PREFIX } from '@/lib/induction-model';
import { DUR_BASE_MS } from '@/lib/motion';
import { stepsFor } from '@/lib/onboarding';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const setStep = vi.fn<(step: string) => Promise<boolean>>(async () => true);

async function mount(withSwitch: boolean): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      withSwitch ? <WorkspaceSwitcher onInductionStep={setStep} /> : <WorkspaceSwitcher />,
    ),
  );
  await act(async () => {
    window.dispatchEvent(new CustomEvent('sorted:switch-workspace'));
  });
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
}

function button(text: string): HTMLButtonElement {
  const found = findButton(text);
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => el.click());
}

/** ConfirmDialog plays its exit before it calls onCancel. */
async function waitExit(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, DUR_BASE_MS + 30));
  });
}

beforeEach(() => {
  mockState.workspaces = [];
  mockStore.mockReset();
  mockStore.mockResolvedValue({ ok: true, data: null });
  setStep.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('X8 approverSwitchShown', () => {
  it('offers the switch to a self sign-up with no workspace', () => {
    expect(
      approverSwitchShown({ workspaceCount: 0, state: { step: WORKSPACE_STEP, done: false } }),
    ).toBe(true);
    expect(approverSwitchShown({ workspaceCount: 0, state: { step: null, done: false } })).toBe(
      true,
    );
  });

  it('never offers it to a workspace holder', () => {
    expect(
      approverSwitchShown({ workspaceCount: 1, state: { step: WORKSPACE_STEP, done: false } }),
    ).toBe(false);
  });

  it('never offers it to an invitee or after the induction is done', () => {
    const invited = `${ROUTE_PREFIX.invited}welcome`;
    expect(approverSwitchShown({ workspaceCount: 0, state: { step: invited, done: false } })).toBe(
      false,
    );
    expect(
      approverSwitchShown({ workspaceCount: 0, state: { step: WORKSPACE_STEP, done: true } }),
    ).toBe(false);
  });

  it('the stored step reopens onboarding on the brand screen', () => {
    // AppLayout's gate: approverStageOf(state) !== 'none' opens OnboardingFlow.
    const stage = approverStageOf({ step: APPROVER_BRAND_STEP, done: false });
    expect(stage).toBe('brand');
    // A Creator's profile is already saved, so the flow starts on the brand screen.
    const steps = stepsFor({
      profileIncomplete: false,
      hasWorkspace: false,
      side: 'approver',
      approverStage: stage,
    });
    expect(steps[0]).toBe('brand');
  });
});

describe('X8 I approve posts instead', () => {
  it('shows a 44px text action on the create step with no workspace', async () => {
    await mount(true);
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
      'Create workspace',
    );
    expect(button(WORKSPACE_CREATE_COPY.approveInstead).className).toContain('min-h-[44px]');
  });

  it('asks before switching, with Keep as Creator and Switch', async () => {
    await mount(true);
    await click(button(WORKSPACE_CREATE_COPY.approveInstead));
    expect(document.body.textContent).toContain('Switch to Approver?');
    expect(document.body.textContent).toContain(
      "You'll tell us your brand and invite the team that makes your posts.",
    );
    expect(findButton('Keep as Creator')).toBeDefined();
    expect(findButton('Switch')).toBeDefined();
  });

  it('Keep as Creator stays on the create step and stores nothing', async () => {
    await mount(true);
    await click(button(WORKSPACE_CREATE_COPY.approveInstead));
    await click(button('Keep as Creator'));
    await waitExit();
    expect(document.body.textContent).not.toContain('Switch to Approver?');
    expect(findButton('Continue')).toBeDefined();
    expect(mockStore).not.toHaveBeenCalled();
    expect(setStep).not.toHaveBeenCalled();
  });

  it('Switch stores the approver brand step and hands it to the induction', async () => {
    await mount(true);
    await click(button(WORKSPACE_CREATE_COPY.approveInstead));
    await click(button('Switch'));
    expect(mockStore).toHaveBeenCalledWith(expect.anything(), {
      step: APPROVER_BRAND_STEP,
      traceId: 'trace-x8',
    });
    expect(setStep).toHaveBeenCalledWith(APPROVER_BRAND_STEP);
  });

  it('a failed switch keeps the dialog and says so', async () => {
    mockStore.mockResolvedValue({ ok: false, error: { code: 'unknown', message: 'down' } });
    await mount(true);
    await click(button(WORKSPACE_CREATE_COPY.approveInstead));
    await click(button('Switch'));
    expect(setStep).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("We couldn't switch that. Try again.");
    expect(findButton('Continue')).toBeDefined();
  });

  it('a workspace holder never sees the action', async () => {
    mockState.workspaces = [{ id: 'ws-1', name: 'Acme', platform: 'linkedin' }];
    await mount(true);
    await click(button('Create workspace'));
    expect(findButton(WORKSPACE_CREATE_COPY.approveInstead)).toBeUndefined();
  });

  it('the full shell (no induction step handed in) never shows it', async () => {
    await mount(false);
    expect(findButton('Continue')).toBeDefined();
    expect(findButton(WORKSPACE_CREATE_COPY.approveInstead)).toBeUndefined();
  });
});

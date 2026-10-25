import { describe, expect, it, vi } from 'vitest';
import {
  reasonFailureTitle,
  runStageMoveCommit,
  showWhenVisible,
  stageMoveFailureTitle,
  type StageMoveCommitDeps,
  type VisibilityDoc,
} from '@/components/pages/pcs/stage-move-commit';

// FB6 regressions: the deferred reject / park commit reports every failure
// through the app-wide toast exactly once, whether the page is still there,
// already gone, or hidden. Node environment: a fake document stands in.

function fakeDoc(visibilityState: string): VisibilityDoc & {
  setVisible: () => void;
  listeners: number;
} {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState,
    addEventListener: (_type: 'visibilitychange', listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: 'visibilitychange', listener: () => void) => {
      listeners.delete(listener);
    },
    setVisible: () => {
      doc.visibilityState = 'visible';
      for (const listener of [...listeners]) listener();
    },
    get listeners() {
      return listeners.size;
    },
  };
  return doc;
}

function harness(overrides: Partial<StageMoveCommitDeps> = {}) {
  const show = vi.fn();
  const deps: StageMoveCommitDeps = {
    to: 'rejected',
    fromStage: 'review',
    postTitle: 'Diwali teaser',
    reason: null,
    transition: async () => ({ ok: true }),
    postReason: async () => ({ ok: true }),
    stillHere: () => true,
    revert: vi.fn(),
    setInlineError: vi.fn(),
    friendlyError: (error) => `friendly:${String(error)}`,
    afterSuccess: vi.fn(),
    toast: { show },
    openPost: vi.fn(),
    doc: fakeDoc('visible'),
    log: vi.fn(),
    ...overrides,
  };
  return { deps, show };
}

describe('stageMoveFailureTitle / reasonFailureTitle', () => {
  it('names the verb, the post and the reason', () => {
    expect(stageMoveFailureTitle('rejected', 'Diwali teaser')).toBe(
      "Couldn't reject Diwali teaser. Try again.",
    );
    expect(stageMoveFailureTitle('parked', 'Diwali teaser', { code: 'forbidden_role' })).toBe(
      "Couldn't park Diwali teaser. You don't have access to do this.",
    );
    expect(reasonFailureTitle('rejected')).toBe("Rejected, but your reason didn't post.");
    expect(reasonFailureTitle('parked')).toBe("Parked, but your reason didn't post.");
  });
});

describe('showWhenVisible', () => {
  it('runs at once while visible, and holds until visible while hidden', () => {
    const now = vi.fn();
    showWhenVisible(fakeDoc('visible'), now);
    expect(now).toHaveBeenCalledTimes(1);

    const doc = fakeDoc('hidden');
    const later = vi.fn();
    showWhenVisible(doc, later);
    expect(later).not.toHaveBeenCalled();
    expect(doc.listeners).toBe(1);
    doc.setVisible();
    expect(later).toHaveBeenCalledTimes(1);
    expect(doc.listeners).toBe(0);
  });
});

describe('runStageMoveCommit', () => {
  it('a refusal after unmount shows the app-wide toast exactly once and touches no page state', async () => {
    const { deps, show } = harness({
      transition: async () => ({ ok: false, error: { code: 'forbidden_role', message: 'x' } }),
      stillHere: () => false,
    });
    await expect(runStageMoveCommit(deps)).resolves.toBeUndefined();
    expect(show).toHaveBeenCalledTimes(1);
    const [options] = show.mock.calls[0] as [
      { title: string; tone?: string; action?: { label: string } },
    ];
    expect(options.title).toBe("Couldn't reject Diwali teaser. You don't have access to do this.");
    expect(options.tone).toBe('error');
    expect(options.action?.label).toBe('Open');
    expect(deps.revert).not.toHaveBeenCalled();
    expect(deps.setInlineError).not.toHaveBeenCalled();
    expect(deps.afterSuccess).not.toHaveBeenCalled();
  });

  it('a refusal while hidden holds the toast and shows it on return to visible', async () => {
    const doc = fakeDoc('hidden');
    const { deps, show } = harness({
      transition: async () => ({ ok: false, error: 'network_failure' }),
      stillHere: () => false,
      doc,
    });
    await runStageMoveCommit(deps);
    expect(show).not.toHaveBeenCalled();
    doc.setVisible();
    expect(show).toHaveBeenCalledTimes(1);
    // A second visibility change never shows it again.
    doc.setVisible();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('a thrown network error is reported the same way, never rethrown', async () => {
    const { deps, show } = harness({
      transition: async () => {
        throw new TypeError('Failed to fetch');
      },
      stillHere: () => true,
    });
    await expect(runStageMoveCommit(deps)).resolves.toBeUndefined();
    expect(show).toHaveBeenCalledTimes(1);
    expect(deps.revert).toHaveBeenCalledTimes(1);
    expect(deps.setInlineError).toHaveBeenCalledWith('friendly:TypeError: Failed to fetch');
    expect(deps.afterSuccess).not.toHaveBeenCalled();
  });

  it('still on the page: a refusal reverts, sets the inline error, and still shows the toast once', async () => {
    const { deps, show } = harness({
      transition: async () => ({ ok: false, error: 'forbidden_role' }),
    });
    await runStageMoveCommit(deps);
    expect(deps.revert).toHaveBeenCalledTimes(1);
    expect(deps.setInlineError).toHaveBeenCalledWith('friendly:forbidden_role');
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('the Open action navigates to the post', async () => {
    const { deps, show } = harness({
      transition: async () => ({ ok: false, error: 'x' }),
      stillHere: () => false,
    });
    await runStageMoveCommit(deps);
    const [options] = show.mock.calls[0] as [{ action?: { onPress: () => void } }];
    options.action?.onPress();
    expect(deps.openPost).toHaveBeenCalledTimes(1);
  });

  it('a landed move whose reason comment fails shows the reason toast, and no failure toast', async () => {
    const { deps, show } = harness({
      reason: 'Logo is off-brand',
      postReason: async () => ({ ok: false }),
      stillHere: () => false,
    });
    await runStageMoveCommit(deps);
    expect(show).toHaveBeenCalledTimes(1);
    const [options] = show.mock.calls[0] as [{ title: string }];
    expect(options.title).toBe("Rejected, but your reason didn't post.");
    expect(deps.revert).not.toHaveBeenCalled();
  });

  it('a thrown reason comment takes the same reason path', async () => {
    const { deps, show } = harness({
      to: 'parked',
      reason: 'Hold for the launch',
      postReason: async () => {
        throw new Error('offline');
      },
    });
    await expect(runStageMoveCommit(deps)).resolves.toBeUndefined();
    expect(show).toHaveBeenCalledTimes(1);
    const [options] = show.mock.calls[0] as [{ title: string }];
    expect(options.title).toBe("Parked, but your reason didn't post.");
    expect(deps.afterSuccess).toHaveBeenCalledTimes(1);
  });

  it('a landed move refreshes only while still here, with no toast', async () => {
    const here = harness();
    await runStageMoveCommit(here.deps);
    expect(here.deps.afterSuccess).toHaveBeenCalledTimes(1);
    expect(here.show).not.toHaveBeenCalled();

    const gone = harness({ stillHere: () => false });
    await runStageMoveCommit(gone.deps);
    expect(gone.deps.afterSuccess).not.toHaveBeenCalled();
    expect(gone.show).not.toHaveBeenCalled();
  });

  it('no app-wide toast surface: the commit still resolves', async () => {
    const { deps } = harness({ toast: null, transition: async () => ({ ok: false, error: 'x' }) });
    await expect(runStageMoveCommit(deps)).resolves.toBeUndefined();
  });
});

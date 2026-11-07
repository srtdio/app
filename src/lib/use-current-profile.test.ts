import { beforeEach, describe, expect, it, vi } from 'vitest';

// A controllable users read: each maybeSingle() call returns a deferred the test
// settles, so in-flight sharing and ordering are observable without a network.
interface Deferred {
  userId: string;
  resolve: (value: { data: unknown; error: { message: string } | null }) => void;
}
const reads: Deferred[] = [];

type AuthCallback = (event: string, session: { user: { id: string } } | null) => void;
const auth = { callbacks: new Set<AuthCallback>() };

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      onAuthStateChange: (cb: AuthCallback) => {
        auth.callbacks.add(cb);
        return { data: { subscription: { unsubscribe: () => auth.callbacks.delete(cb) } } };
      },
    },
    from: () => ({
      select: () => ({
        eq: (_col: string, userId: string) => ({
          maybeSingle: () =>
            new Promise((resolve) => {
              reads.push({ userId, resolve });
            }),
        }),
      }),
    }),
  },
}));

const density = vi.hoisted(() => ({
  adoptUserDensity: vi.fn(),
  reconcileDensity: vi.fn(),
}));
vi.mock('@/lib/density', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/density')>()),
  adoptUserDensity: density.adoptUserDensity,
  reconcileDensity: density.reconcileDensity,
}));

import {
  authEndsSnapshot,
  getProfileSnapshot,
  loadProfile,
  profileReadKey,
  profileViewFor,
  resetProfileStore,
  setProfileEmailOptIn,
  subscribeProfile,
  toCurrentProfile,
  PROFILE_COLUMNS,
  type CurrentProfile,
} from '@/lib/use-current-profile';
import { peekKept, primeRead, resetSessionReads } from '@/lib/session-read';

function row(name: string, avatar: string | null = null): CurrentProfile {
  return {
    display_name: name,
    designation: null,
    avatar_url: avatar,
    email_opt_in: true,
    profile_completed_at: '2026-09-01T00:00:00Z',
    username: null,
    emailOptOutBy: null,
  };
}

/** The row as the users read (or an old saved copy) has it: no emailOptOutBy. */
function bareRow(name: string): Omit<CurrentProfile, 'emailOptOutBy'> {
  return {
    display_name: name,
    designation: null,
    avatar_url: null,
    email_opt_in: true,
    profile_completed_at: '2026-09-01T00:00:00Z',
    username: null,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  reads.length = 0;
  resetSessionReads();
  resetProfileStore(null);
  density.adoptUserDensity.mockClear();
  density.reconcileDensity.mockClear();
});

describe('shared profile store', () => {
  it('two subscribers (header and panel) make one read and see one snapshot', async () => {
    const header = vi.fn();
    const panel = vi.fn();
    const offA = subscribeProfile(header);
    const offB = subscribeProfile(panel);

    void loadProfile('u-1');
    void loadProfile('u-1');
    expect(reads).toHaveLength(1);

    reads[0]?.resolve({ data: row('Asha'), error: null });
    await flush();
    expect(getProfileSnapshot()).toEqual({
      userId: 'u-1',
      profile: row('Asha'),
      loading: false,
      error: false,
    });
    expect(header).toHaveBeenCalled();
    expect(panel).toHaveBeenCalled();
    offA();
    offB();
  });

  it('refetch from one caller updates every subscriber', async () => {
    void loadProfile('u-1');
    reads[0]?.resolve({ data: row('Asha', 'https://cdn/old.png'), error: null });
    await flush();

    const header = vi.fn();
    const panel = vi.fn();
    const offA = subscribeProfile(header);
    const offB = subscribeProfile(panel);
    void loadProfile('u-1', true);
    expect(reads).toHaveLength(2);
    // Still showing the last good row while the refetch runs: no loading flash.
    expect(getProfileSnapshot().loading).toBe(false);
    reads[1]?.resolve({ data: row('Asha', null), error: null });
    await flush();

    expect(getProfileSnapshot().profile?.avatar_url).toBeNull();
    expect(header).toHaveBeenCalledOnce();
    expect(panel).toHaveBeenCalledOnce();
    offA();
    offB();
  });

  it('a refetch during a read queues exactly one follow-up read', async () => {
    void loadProfile('u-1');
    void loadProfile('u-1', true);
    void loadProfile('u-1', true);
    expect(reads).toHaveLength(1);
    reads[0]?.resolve({ data: row('Old'), error: null });
    await flush();
    expect(reads).toHaveLength(2);
    reads[1]?.resolve({ data: row('New'), error: null });
    await flush();
    expect(reads).toHaveLength(2);
    expect(getProfileSnapshot().profile?.display_name).toBe('New');
  });

  it('a user change clears the snapshot before the new read', async () => {
    void loadProfile('u-1');
    reads[0]?.resolve({ data: row('Asha'), error: null });
    await flush();

    // First render as the new user, before any effect runs: nothing of u-1.
    expect(profileViewFor(getProfileSnapshot(), 'u-2')).toEqual({
      userId: 'u-2',
      profile: null,
      loading: true,
      error: false,
    });
    expect(profileViewFor(getProfileSnapshot(), null).profile).toBeNull();

    void loadProfile('u-2');
    expect(getProfileSnapshot()).toEqual({
      userId: 'u-2',
      profile: null,
      loading: true,
      error: false,
    });
    expect(reads).toHaveLength(2);
    reads[1]?.resolve({ data: row('Ravi'), error: null });
    await flush();
    expect(getProfileSnapshot().profile?.display_name).toBe('Ravi');
  });

  it('drops a read that lands after the user changed', async () => {
    void loadProfile('u-1');
    void loadProfile('u-2');
    reads[0]?.resolve({ data: row('Asha'), error: null });
    await flush();
    expect(getProfileSnapshot().profile).toBeNull();
    expect(getProfileSnapshot().userId).toBe('u-2');
  });

  it('sign-out resets the store synchronously', async () => {
    void loadProfile('u-1');
    reads[0]?.resolve({ data: row('Asha'), error: null });
    await flush();
    resetProfileStore(null);
    expect(getProfileSnapshot()).toEqual({
      userId: null,
      profile: null,
      loading: true,
      error: false,
    });
  });

  it('a failed read keeps the last good snapshot and flags the error', async () => {
    void loadProfile('u-1');
    reads[0]?.resolve({ data: row('Asha'), error: null });
    await flush();

    void loadProfile('u-1', true);
    reads[1]?.resolve({ data: null, error: { message: 'network' } });
    await flush();
    expect(getProfileSnapshot()).toEqual({
      userId: 'u-1',
      profile: row('Asha'),
      loading: false,
      error: true,
    });
  });

  it('a failed first read reports error with no profile, as before', async () => {
    void loadProfile('u-1');
    reads[0]?.resolve({ data: null, error: { message: 'network' } });
    await flush();
    expect(getProfileSnapshot()).toEqual({
      userId: 'u-1',
      profile: null,
      loading: false,
      error: true,
    });
  });
});

function emitAuth(event: string, userId: string | null): void {
  for (const cb of auth.callbacks) cb(event, userId === null ? null : { user: { id: userId } });
}

async function loaded(userId: string, name: string): Promise<void> {
  void loadProfile(userId);
  reads[reads.length - 1]?.resolve({ data: row(name), error: null });
  await flush();
}

describe('auth-driven reset (F6)', () => {
  it('sign-out via the auth event resets the store', async () => {
    const off = subscribeProfile(() => {});
    await loaded('u-1', 'Asha');
    emitAuth('SIGNED_OUT', null);
    expect(getProfileSnapshot()).toEqual({
      userId: null,
      profile: null,
      loading: true,
      error: false,
    });
    off();
  });

  it('a different user from the auth event resets; a transient null does not', async () => {
    const off = subscribeProfile(() => {});
    await loaded('u-1', 'Asha');
    emitAuth('TOKEN_REFRESHED', null);
    expect(getProfileSnapshot().profile?.display_name).toBe('Asha');
    emitAuth('TOKEN_REFRESHED', 'u-1');
    expect(getProfileSnapshot().profile?.display_name).toBe('Asha');
    emitAuth('SIGNED_IN', 'u-2');
    expect(getProfileSnapshot().userId).toBeNull();
    off();
  });

  it('a sorted:signout dispatch alone does not reset', async () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const off = subscribeProfile(() => {});
    await loaded('u-1', 'Asha');
    target.dispatchEvent(new Event('sorted:signout'));
    expect(getProfileSnapshot().profile?.display_name).toBe('Asha');
    off();
    vi.unstubAllGlobals();
  });

  it('subscribes to auth at the first subscriber and unsubscribes at the last', () => {
    expect(auth.callbacks.size).toBe(0);
    const offA = subscribeProfile(() => {});
    const offB = subscribeProfile(() => {});
    expect(auth.callbacks.size).toBe(1);
    offA();
    expect(auth.callbacks.size).toBe(1);
    offB();
    expect(auth.callbacks.size).toBe(0);
  });

  it('authEndsSnapshot is false with nothing held', () => {
    expect(authEndsSnapshot('SIGNED_OUT', null, null)).toBe(false);
  });
});

describe('no extra reads (F7)', () => {
  it('a mount with a loaded snapshot makes 0 reads', async () => {
    await loaded('u-1', 'Asha');
    expect(reads).toHaveLength(1);
    void loadProfile('u-1');
    expect(reads).toHaveLength(1);
  });

  it('a mount after a failed read makes 0 reads; Retry (force) reads', async () => {
    void loadProfile('u-1');
    reads[0]?.resolve({ data: null, error: { message: 'network' } });
    await flush();
    void loadProfile('u-1');
    expect(reads).toHaveLength(1);
    void loadProfile('u-1', true);
    expect(reads).toHaveLength(2);
  });

  it('a mount with a read in flight makes 0 new reads', () => {
    void loadProfile('u-1');
    void loadProfile('u-1');
    expect(reads).toHaveLength(1);
  });
});

describe('stale results (F8)', () => {
  it('an older sequence result is dropped (A to B to A)', async () => {
    void loadProfile('u-a');
    void loadProfile('u-b');
    void loadProfile('u-a');
    expect(reads).toHaveLength(3);
    reads[2]?.resolve({ data: row('A new'), error: null });
    await flush();
    reads[0]?.resolve({ data: row('A old'), error: null });
    await flush();
    expect(getProfileSnapshot().profile?.display_name).toBe('A new');
  });
});

describe('device cache (cold open)', () => {
  it('a saved row is the first snapshot (not loading) and the first read still runs and replaces it', async () => {
    primeRead(profileReadKey('u-1'), row('Saved'));
    void loadProfile('u-1');
    expect(getProfileSnapshot()).toEqual({
      userId: 'u-1',
      profile: row('Saved'),
      loading: false,
      error: false,
    });
    expect(reads).toHaveLength(1);
    reads[0]?.resolve({ data: row('Fresh'), error: null });
    await flush();
    expect(getProfileSnapshot().profile).toEqual(row('Fresh'));
    // Settled: another mount reads nothing.
    void loadProfile('u-1');
    expect(reads).toHaveLength(1);
  });

  it('a failed first read keeps the saved row (fail open)', async () => {
    primeRead(profileReadKey('u-1'), row('Saved'));
    void loadProfile('u-1');
    reads[0]?.resolve({ data: null, error: { message: 'down' } });
    await flush();
    expect(getProfileSnapshot()).toMatchObject({ profile: row('Saved'), error: true });
  });

  it('another user never sees the saved row', () => {
    primeRead(profileReadKey('u-1'), row('Saved'));
    void loadProfile('u-2');
    expect(getProfileSnapshot()).toMatchObject({ userId: 'u-2', profile: null, loading: true });
  });
});

describe('setProfileEmailOptIn (own write)', () => {
  it('patches the held row and the saved copy with no read', async () => {
    void loadProfile('u-1');
    reads[0]?.resolve({ data: row('Asha'), error: null });
    await flush();
    const listener = vi.fn();
    const off = subscribeProfile(listener);
    setProfileEmailOptIn('u-1', false);
    expect(reads).toHaveLength(1);
    expect(getProfileSnapshot().profile?.email_opt_in).toBe(false);
    expect(getProfileSnapshot().profile?.display_name).toBe('Asha');
    expect(peekKept<CurrentProfile>(profileReadKey('u-1'))?.email_opt_in).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
    off();
  });

  it("the person's own tick clears a manager's emailOptOutBy, on or off", async () => {
    void loadProfile('u-1');
    reads[0]?.resolve({
      data: { ...row('Asha'), email_opt_in: false, emailOptOutBy: 'u-boss' },
      error: null,
    });
    await flush();
    setProfileEmailOptIn('u-1', false);
    expect(getProfileSnapshot().profile?.email_opt_in).toBe(false);
    expect(getProfileSnapshot().profile?.emailOptOutBy).toBeNull();
    expect(peekKept<CurrentProfile>(profileReadKey('u-1'))?.emailOptOutBy).toBeNull();
  });

  it('leaves another user, or no row yet, alone', () => {
    void loadProfile('u-1');
    setProfileEmailOptIn('u-1', false);
    expect(getProfileSnapshot().profile).toBeNull();
    setProfileEmailOptIn('u-2', false);
    expect(getProfileSnapshot().userId).toBe('u-1');
  });
});

describe('emailOptOutBy (who turned catch-up emails off)', () => {
  it('the one users read selects email_opt_out_by', () => {
    expect(PROFILE_COLUMNS.split(', ')).toContain('email_opt_out_by');
    expect(PROFILE_COLUMNS.split(', ')).toContain('email_opt_in');
  });

  it('maps the read column onto profile.emailOptOutBy', async () => {
    void loadProfile('u-1');
    reads[0]?.resolve({
      data: { ...bareRow('Asha'), email_opt_in: false, email_opt_out_by: 'u-boss' },
      error: null,
    });
    await flush();
    const profile = getProfileSnapshot().profile;
    expect(profile?.emailOptOutBy).toBe('u-boss');
    expect(profile && 'email_opt_out_by' in profile).toBe(false);
  });

  it('a copy saved before the field existed paints with emailOptOutBy null', () => {
    primeRead(profileReadKey('u-1'), bareRow('Asha'));
    void loadProfile('u-1');
    expect(getProfileSnapshot().profile?.emailOptOutBy).toBeNull();
  });

  it('toCurrentProfile prefers the column, then the held field, else null', () => {
    const base = bareRow('Asha');
    expect(toCurrentProfile({ ...base, email_opt_out_by: 'u-a' }).emailOptOutBy).toBe('u-a');
    expect(toCurrentProfile({ ...base, emailOptOutBy: 'u-b' }).emailOptOutBy).toBe('u-b');
    expect(toCurrentProfile(base).emailOptOutBy).toBeNull();
  });
});

describe('density (users.density, read with the profile)', () => {
  it('the one users read selects density (no second read)', () => {
    expect(PROFILE_COLUMNS.split(', ')).toContain('density');
    expect(PROFILE_COLUMNS).toBe(
      'display_name, designation, avatar_url, email_opt_in, profile_completed_at, username, email_opt_out_by, density',
    );
  });

  it('a known session adopts that account\'s device density first (sync), before the read lands', () => {
    void loadProfile('u-1');
    expect(density.adoptUserDensity).toHaveBeenCalledTimes(1);
    expect(density.adoptUserDensity).toHaveBeenCalledWith('u-1');
    expect(density.reconcileDensity).not.toHaveBeenCalled();
    resetProfileStore(null);
    expect(density.adoptUserDensity).toHaveBeenCalledTimes(1);
  });

  it('a successful read reconciles the server density once; a failed read does not', async () => {
    void loadProfile('u-1');
    reads[0]?.resolve({ data: { ...bareRow('Asha'), density: 'calm' }, error: null });
    await flush();
    expect(density.reconcileDensity).toHaveBeenCalledTimes(1);
    expect(density.reconcileDensity).toHaveBeenCalledWith('u-1', 'calm');
    expect(reads).toHaveLength(1);

    resetProfileStore(null);
    density.reconcileDensity.mockClear();
    void loadProfile('u-2');
    reads[1]?.resolve({ data: null, error: { message: 'down' } });
    await flush();
    expect(density.reconcileDensity).not.toHaveBeenCalled();
  });

  it('a stale read (the user changed mid-read) never reconciles', async () => {
    void loadProfile('u-1');
    void loadProfile('u-2');
    reads[0]?.resolve({ data: { ...bareRow('Old'), density: 'compact' }, error: null });
    await flush();
    expect(density.reconcileDensity).not.toHaveBeenCalled();
  });
});

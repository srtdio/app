// End-to-end auth flows against a local, ephemeral Supabase stack.
//
// Assertion paths run as the authenticated end user (the anon-key client and the
// sessions it mints); the service role is used only to seed users and to pull
// magic-link / recovery tokens out of band (admin.generateLink sends no email).
// Reuses seedUser / clientFor from the shared RLS test utilities.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createAdminClient,
  createAnonClient,
  generateTraceId,
  randomSuffix,
  seedUser,
} from '../../packages/test-utils/rls';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import {
  confirmPasswordReset,
  loginWithPassword,
  refreshSession,
  requestPasswordReset,
  signOut,
  signupWithMagicLink,
  verifyAccessToken,
  verifyMagicLink,
} from '@/server/auth';
import { loadAuthTestEnv, signExpiredAccessToken, type AuthTestEnv } from './env';

const AUTH_SUITE = process.env.AUTH_SUITE === '1';

describe.runIf(AUTH_SUITE)('auth server flows', () => {
  let env: AuthTestEnv;
  let admin: SupabaseClient<Database>;
  const createdUserIds: string[] = [];

  const uniqueEmail = (): string => `auth_${randomSuffix()}@example.test`;
  const anon = (): SupabaseClient<Database> => createAnonClient(env);

  /** Create a confirmed auth user (no email) and mirror a display name. */
  async function adminCreateUser(displayName: string): Promise<{ id: string; email: string }> {
    const email = uniqueEmail();
    const created = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { full_name: displayName },
    });
    if (created.error || !created.data.user) {
      throw new Error(`createUser failed: ${created.error?.message ?? 'no user'}`);
    }
    createdUserIds.push(created.data.user.id);
    return { id: created.data.user.id, email };
  }

  async function magicLinkToken(email: string): Promise<string> {
    const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (error || !data.properties) {
      throw new Error(`generateLink magiclink failed: ${error?.message ?? 'no properties'}`);
    }
    return data.properties.hashed_token;
  }

  async function recoveryToken(email: string): Promise<string> {
    const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email });
    if (error || !data.properties) {
      throw new Error(`generateLink recovery failed: ${error?.message ?? 'no properties'}`);
    }
    return data.properties.hashed_token;
  }

  beforeAll(() => {
    env = loadAuthTestEnv();
    admin = createAdminClient(env);
  });

  afterAll(async () => {
    for (const id of createdUserIds) {
      await admin.auth.admin.deleteUser(id);
    }
  });

  // --- Signup ---------------------------------------------------------------

  it('signup: success creates the profile row from display_name', async () => {
    const email = uniqueEmail();
    const displayName = `Casey ${randomSuffix()}`;

    const res = await signupWithMagicLink(
      anon(),
      { email, displayName, timezone: 'Asia/Kolkata' },
      generateTraceId(),
    );
    expect(res.ok).toBe(true);

    // Resolve the new user id out of band (no email) and check the trigger ran.
    const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    const userId = link.data.user?.id;
    expect(userId).toBeTruthy();
    if (userId) createdUserIds.push(userId);

    const profile = await admin
      .from('users')
      .select('display_name')
      .eq('id', userId ?? '')
      .single();
    expect(profile.error).toBeNull();
    expect(profile.data?.display_name).toBe(displayName);
  });

  it('signup: rejects an empty display_name without calling the provider', async () => {
    const res = await signupWithMagicLink(
      anon(),
      { email: uniqueEmail(), displayName: '   ', timezone: 'UTC' },
      generateTraceId(),
    );
    expect(res).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'invalid_display_name' }),
    });
  });

  it('signup: rejects a display_name longer than 80 chars', async () => {
    const res = await signupWithMagicLink(
      anon(),
      { email: uniqueEmail(), displayName: 'a'.repeat(81), timezone: 'UTC' },
      generateTraceId(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('invalid_display_name');
  });

  // --- Login ----------------------------------------------------------------

  it('login: succeeds with the correct password', async () => {
    const user = await seedUser(env, admin);
    createdUserIds.push(user.id);

    const res = await loginWithPassword(
      anon(),
      { email: user.email, password: user.password },
      generateTraceId(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.userId).toBe(user.id);
  });

  it('login: fails with the wrong password', async () => {
    const user = await seedUser(env, admin);
    createdUserIds.push(user.id);

    const res = await loginWithPassword(
      anon(),
      { email: user.email, password: 'wrong-password-xyz' },
      generateTraceId(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('invalid_credentials');
  });

  // --- Magic-link verification ----------------------------------------------

  it('magic-link verify: succeeds and yields an authenticated session', async () => {
    const displayName = `Rowan ${randomSuffix()}`;
    const { email } = await adminCreateUser(displayName);
    const tokenHash = await magicLinkToken(email);

    const res = await verifyMagicLink(anon(), { tokenHash, type: 'magiclink' }, generateTraceId());
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // The returned session must work as an authenticated user.
    const authed = anon();
    await authed.auth.setSession({
      access_token: res.data.accessToken,
      refresh_token: res.data.refreshToken,
    });
    const profile = await authed
      .from('users')
      .select('display_name')
      .eq('id', res.data.userId)
      .single();
    expect(profile.error).toBeNull();
    expect(profile.data?.display_name).toBe(displayName);
  });

  it('magic-link verify: rejects an expired (already-used) token', async () => {
    const { email } = await adminCreateUser(`Sam ${randomSuffix()}`);
    const tokenHash = await magicLinkToken(email);

    const first = await verifyMagicLink(
      anon(),
      { tokenHash, type: 'magiclink' },
      generateTraceId(),
    );
    expect(first.ok).toBe(true);

    // Reusing the consumed token is GoTrue's expired/invalid path.
    const second = await verifyMagicLink(
      anon(),
      { tokenHash, type: 'magiclink' },
      generateTraceId(),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('expired_token');
  });

  // --- Password reset -------------------------------------------------------

  it('password reset: request then confirm sets a new working password', async () => {
    const user = await seedUser(env, admin);
    createdUserIds.push(user.id);

    const requested = await requestPasswordReset(anon(), { email: user.email }, generateTraceId());
    expect(requested.ok).toBe(true);

    const tokenHash = await recoveryToken(user.email);
    const newPassword = `Np_${randomSuffix()}_${randomSuffix()}`;
    const confirmed = await confirmPasswordReset(
      anon(),
      { tokenHash, newPassword },
      generateTraceId(),
    );
    expect(confirmed.ok).toBe(true);

    // Old password no longer works; the new one does.
    const oldLogin = await loginWithPassword(
      anon(),
      { email: user.email, password: user.password },
      generateTraceId(),
    );
    expect(oldLogin.ok).toBe(false);
    const newLogin = await loginWithPassword(
      anon(),
      { email: user.email, password: newPassword },
      generateTraceId(),
    );
    expect(newLogin.ok).toBe(true);
  });

  // --- Refresh / sign-out ---------------------------------------------------

  it('refresh: exchanges a refresh token for a fresh session', async () => {
    const user = await seedUser(env, admin);
    createdUserIds.push(user.id);

    const login = await loginWithPassword(
      anon(),
      { email: user.email, password: user.password },
      generateTraceId(),
    );
    expect(login.ok).toBe(true);
    if (!login.ok) return;

    const res = await refreshSession(
      anon(),
      { refreshToken: login.data.refreshToken },
      generateTraceId(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.userId).toBe(user.id);
      expect(res.data.accessToken.length).toBeGreaterThan(0);
    }
  });

  it('refresh: fails after sign-out revokes the refresh token', async () => {
    const user = await seedUser(env, admin);
    createdUserIds.push(user.id);

    const login = await loginWithPassword(
      anon(),
      { email: user.email, password: user.password },
      generateTraceId(),
    );
    expect(login.ok).toBe(true);
    if (!login.ok) return;

    const out = await signOut(
      anon(),
      { accessToken: login.data.accessToken, refreshToken: login.data.refreshToken },
      generateTraceId(),
    );
    expect(out.ok).toBe(true);

    const res = await refreshSession(
      anon(),
      { refreshToken: login.data.refreshToken },
      generateTraceId(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(['session_revoked', 'invalid_token']).toContain(res.error.code);
  });

  // --- Access token verification --------------------------------------------

  it('access token: an expired token is rejected', async () => {
    const user = await seedUser(env, admin);
    createdUserIds.push(user.id);

    const expired = await signExpiredAccessToken(env, user.id);
    const res = await verifyAccessToken(anon(), expired, generateTraceId());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('expired_token');
  });
});

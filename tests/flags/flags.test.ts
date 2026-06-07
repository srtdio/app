// E2E tests for the feature-flag module against a local, ephemeral Supabase.
//
// Gated on RLS_SUITE (set by tests/flags/vitest.config.ts) so the default unit
// run never reaches a database. Seeding and setFlag use the service role; flag
// evaluation/listing is asserted through authenticated user clients (clientFor),
// never the service role. The audit-row assertion is the one exception: audit_log
// is operator-read-only, so verifying setFlag's side effect requires the admin
// client.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  asGeneric,
  cleanupWorkspaces,
  countWhere,
  createAdminClient,
  clientFor,
  generateTraceId,
  loadRlsEnv,
  randomSuffix,
  seedUser,
  seedWorkspace,
  type SeededUser,
  type SeededWorkspace,
} from '../../packages/test-utils/rls';
import type { Database } from '../../packages/schemas/src/supabase.generated';
import { evalFlag, listFlags, setFlag, FlagValidationError } from '../../src/server/flags';

const RLS_SUITE = process.env.RLS_SUITE === '1';

function flagName(): string {
  // ^[a-z][a-z0-9_]{0,99}$ : a leading letter then hex from randomSuffix().
  return `f${randomSuffix().replace(/-/g, '')}`;
}

describe.runIf(RLS_SUITE)('feature-flag module (e2e)', () => {
  let admin: SupabaseClient<Database>;
  let userA: SeededUser;
  let userB: SeededUser;
  let wsA: SeededWorkspace;
  let wsB: SeededWorkspace;
  let clientA: SupabaseClient<Database>;
  let clientB: SupabaseClient<Database>;

  beforeAll(async () => {
    const env = loadRlsEnv();
    admin = createAdminClient(env);
    userA = await seedUser(env, admin);
    userB = await seedUser(env, admin);
    wsA = await seedWorkspace(admin, userA, `Flags A ${userA.email}`);
    wsB = await seedWorkspace(admin, userB, `Flags B ${userB.email}`);
    clientA = clientFor(userA.id);
    clientB = clientFor(userB.id);
  });

  afterAll(async () => {
    await cleanupWorkspaces(admin, [wsA, wsB], [userA, userB]);
  });

  // Convenience writer: always service-role, fresh trace, owner as author.
  async function write(params: {
    flagName: string;
    workspaceId: string | null;
    enabled: boolean;
    category: string;
    rolloutPercentage?: number;
    tierMin?: string | null;
    reason?: string | null;
    traceId?: string;
  }): Promise<void> {
    await setFlag({
      client: admin,
      traceId: params.traceId ?? generateTraceId(),
      flagName: params.flagName,
      workspaceId: params.workspaceId,
      enabled: params.enabled,
      category: params.category,
      rolloutPercentage: params.rolloutPercentage ?? 0,
      tierMin: params.tierMin ?? null,
      reason: params.reason ?? null,
      updatedByUserId: userA.id,
    });
  }

  it('workspace override wins over the global row', async () => {
    const name = flagName();
    await write({ flagName: name, workspaceId: null, enabled: false, category: 'killswitch' });
    await write({ flagName: name, workspaceId: wsA.id, enabled: true, category: 'killswitch' });

    const inWorkspace = await evalFlag({
      client: clientA,
      flagName: name,
      workspaceId: wsA.id,
      userId: userA.id,
      planTier: 'solo',
    });
    expect(inWorkspace.enabled).toBe(true);
  });

  it('falls through to the global row when no workspace override exists', async () => {
    const name = flagName();
    await write({ flagName: name, workspaceId: null, enabled: true, category: 'killswitch' });

    const result = await evalFlag({
      client: clientA,
      flagName: name,
      workspaceId: wsA.id,
      userId: userA.id,
      planTier: 'solo',
    });
    expect(result.enabled).toBe(true);
  });

  it('returns enabled=false / flag_not_found when neither row exists', async () => {
    const result = await evalFlag({
      client: clientA,
      flagName: flagName(),
      workspaceId: wsA.id,
      userId: userA.id,
      planTier: 'solo',
    });
    expect(result).toEqual({ enabled: false, reason: 'flag_not_found' });
  });

  it('killswitch governs directly and ignores rollout_percentage', async () => {
    const on = flagName();
    await write({
      flagName: on,
      workspaceId: null,
      enabled: true,
      category: 'killswitch',
      rolloutPercentage: 0,
    });
    const off = flagName();
    await write({
      flagName: off,
      workspaceId: null,
      enabled: false,
      category: 'killswitch',
      rolloutPercentage: 100,
    });

    const onResult = await evalFlag({
      client: clientA,
      flagName: on,
      workspaceId: null,
      userId: userA.id,
      planTier: 'solo',
    });
    const offResult = await evalFlag({
      client: clientA,
      flagName: off,
      workspaceId: null,
      userId: userA.id,
      planTier: 'solo',
    });
    expect(onResult.enabled).toBe(true);
    expect(offResult.enabled).toBe(false);
  });

  it('rollout bucketing is deterministic for a fixed (userId, flagName)', async () => {
    const name = flagName();
    await write({
      flagName: name,
      workspaceId: null,
      enabled: true,
      category: 'rollout',
      rolloutPercentage: 50,
    });

    const userId = `det-${randomSuffix()}`;
    const first = await evalFlag({
      client: clientA,
      flagName: name,
      workspaceId: null,
      userId,
      planTier: 'solo',
    });
    const second = await evalFlag({
      client: clientA,
      flagName: name,
      workspaceId: null,
      userId,
      planTier: 'solo',
    });
    expect(first.enabled).toBe(second.enabled);
  });

  it('rollout 0% never enables and 100% always enables', async () => {
    const zero = flagName();
    await write({
      flagName: zero,
      workspaceId: null,
      enabled: true,
      category: 'rollout',
      rolloutPercentage: 0,
    });
    const full = flagName();
    await write({
      flagName: full,
      workspaceId: null,
      enabled: true,
      category: 'rollout',
      rolloutPercentage: 100,
    });

    for (let i = 0; i < 40; i += 1) {
      const userId = `roll-${i}-${randomSuffix()}`;
      const zeroResult = await evalFlag({
        client: clientA,
        flagName: zero,
        workspaceId: null,
        userId,
        planTier: 'solo',
      });
      const fullResult = await evalFlag({
        client: clientA,
        flagName: full,
        workspaceId: null,
        userId,
        planTier: 'solo',
      });
      expect(zeroResult.enabled).toBe(false);
      expect(fullResult.enabled).toBe(true);
    }
  });

  it('rollout 50% enables roughly half across many userIds', async () => {
    const name = flagName();
    await write({
      flagName: name,
      workspaceId: null,
      enabled: true,
      category: 'rollout',
      rolloutPercentage: 50,
    });

    const n = 200;
    let enabled = 0;
    for (let i = 0; i < n; i += 1) {
      const result = await evalFlag({
        client: clientA,
        flagName: name,
        workspaceId: null,
        userId: `half-${i}-${randomSuffix()}`,
        planTier: 'solo',
      });
      if (result.enabled) {
        enabled += 1;
      }
    }
    const ratio = enabled / n;
    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThan(0.65);
  });

  it('experiment assignment is sticky per userId', async () => {
    const name = flagName();
    await write({
      flagName: name,
      workspaceId: null,
      enabled: true,
      category: 'experiment',
      rolloutPercentage: 50,
    });

    const userId = `exp-${randomSuffix()}`;
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        evalFlag({
          client: clientA,
          flagName: name,
          workspaceId: null,
          userId,
          planTier: 'solo',
        }),
      ),
    );
    const enabledValues = new Set(results.map((r) => r.enabled));
    expect(enabledValues.size).toBe(1);
  });

  it('tier_gated denies below tier_min and allows at or above it', async () => {
    const name = flagName();
    await write({
      flagName: name,
      workspaceId: null,
      enabled: true,
      category: 'tier_gated',
      tierMin: 'agency',
    });

    const solo = await evalFlag({
      client: clientA,
      flagName: name,
      workspaceId: null,
      userId: userA.id,
      planTier: 'solo',
    });
    const agency = await evalFlag({
      client: clientA,
      flagName: name,
      workspaceId: null,
      userId: userA.id,
      planTier: 'agency',
    });
    expect(solo.enabled).toBe(false);
    expect(agency.enabled).toBe(true);
  });

  it('listFlags merges workspace overrides over global with a source note', async () => {
    const overridden = flagName();
    const globalOnly = flagName();
    await write({
      flagName: overridden,
      workspaceId: null,
      enabled: false,
      category: 'killswitch',
    });
    await write({
      flagName: overridden,
      workspaceId: wsA.id,
      enabled: true,
      category: 'killswitch',
    });
    await write({ flagName: globalOnly, workspaceId: null, enabled: true, category: 'killswitch' });

    const effective = await listFlags({ client: clientA, workspaceId: wsA.id });
    const byName = new Map(effective.map((f) => [f.flagName, f]));

    expect(byName.get(overridden)?.source).toBe('workspace');
    expect(byName.get(overridden)?.enabled).toBe(true);
    expect(byName.get(globalOnly)?.source).toBe('global');
    expect(byName.get(globalOnly)?.enabled).toBe(true);
  });

  it('workspace B cannot see workspace A overrides (RLS-scoped reads)', async () => {
    const name = flagName();
    await write({ flagName: name, workspaceId: null, enabled: false, category: 'killswitch' });
    await write({ flagName: name, workspaceId: wsA.id, enabled: true, category: 'killswitch' });

    // userB reads with workspaceId A but is not a member, so the A override is
    // invisible; resolution falls through to the global row.
    const result = await evalFlag({
      client: clientB,
      flagName: name,
      workspaceId: wsA.id,
      userId: userB.id,
      planTier: 'solo',
    });
    expect(result.enabled).toBe(false);
  });

  it('setFlag rejects an invalid category', async () => {
    await expect(
      write({ flagName: flagName(), workspaceId: null, enabled: true, category: 'bogus' }),
    ).rejects.toBeInstanceOf(FlagValidationError);
  });

  it('setFlag rejects an invalid rollout_percentage', async () => {
    await expect(
      write({
        flagName: flagName(),
        workspaceId: null,
        enabled: true,
        category: 'rollout',
        rolloutPercentage: 33,
      }),
    ).rejects.toBeInstanceOf(FlagValidationError);
  });

  it('setFlag rejects a flag_name that violates the regex', async () => {
    await expect(
      write({ flagName: 'Bad-Name', workspaceId: null, enabled: true, category: 'killswitch' }),
    ).rejects.toBeInstanceOf(FlagValidationError);
  });

  it('setFlag writes an audit_log row carrying the supplied trace_id', async () => {
    const traceId = generateTraceId();
    await write({
      flagName: flagName(),
      workspaceId: wsA.id,
      enabled: true,
      category: 'killswitch',
      traceId,
    });

    const count = await countWhere(asGeneric(admin), 'audit_log', [['trace_id', traceId]]);
    expect(count).toBe(1);
  });

  it('setFlag upserts: a second write updates the existing row in place', async () => {
    const name = flagName();
    await write({ flagName: name, workspaceId: wsA.id, enabled: false, category: 'killswitch' });
    await write({ flagName: name, workspaceId: wsA.id, enabled: true, category: 'killswitch' });

    const count = await countWhere(asGeneric(admin), 'feature_flags', [
      ['workspace_id', wsA.id],
      ['flag_name', name],
    ]);
    expect(count).toBe(1);

    const result = await evalFlag({
      client: clientA,
      flagName: name,
      workspaceId: wsA.id,
      userId: userA.id,
      planTier: 'solo',
    });
    expect(result.enabled).toBe(true);
  });
});

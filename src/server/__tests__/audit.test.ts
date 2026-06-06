import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeAuditLog, type AuditWrite } from '@/server/audit';

const rpc = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));

const TRACE_ID = '0192f8a0-7d3e-7c4b-9a1f-2b3c4d5e6f70';

function valid(overrides: Partial<AuditWrite> = {}): AuditWrite {
  return {
    traceId: TRACE_ID,
    action: 'post.stage.transition',
    outcome: 'success',
    ...overrides,
  };
}

describe('writeAuditLog', () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: TRACE_ID, error: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls audit_log_write and resolves on success', async () => {
    await expect(writeAuditLog(valid())).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]?.[0]).toBe('audit_log_write');
  });

  it('maps every field to its p_ column argument', async () => {
    await writeAuditLog({
      traceId: TRACE_ID,
      action: 'billing.charge_failed',
      outcome: 'failure',
      workspaceId: 'ws-1',
      entityType: 'invoice',
      entityId: 'inv-9',
      errorCode: 'card_declined',
      onBehalfOf: 'user-2',
      impersonationSessionId: 'sess-3',
      ipSubnet: '203.0.113.0/24',
      payload: { amount: 1200 },
    });

    expect(rpc.mock.calls[0]?.[1]).toEqual({
      p_action: 'billing.charge_failed',
      p_outcome: 'failure',
      p_trace_id: TRACE_ID,
      p_workspace_id: 'ws-1',
      p_entity_type: 'invoice',
      p_entity_id: 'inv-9',
      p_payload: { amount: 1200 },
      p_error_code: 'card_declined',
      p_on_behalf_of: 'user-2',
      p_impersonation_session_id: 'sess-3',
      p_ip_subnet: '203.0.113.0/24',
    });
  });

  it('defaults omitted optional fields to null', async () => {
    await writeAuditLog(valid());
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({
      p_workspace_id: null,
      p_entity_type: null,
      p_entity_id: null,
      p_payload: null,
      p_error_code: null,
      p_on_behalf_of: null,
      p_impersonation_session_id: null,
      p_ip_subnet: null,
    });
  });

  it('never sends an actor or _trace_id argument', async () => {
    await writeAuditLog(valid());
    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args).not.toHaveProperty('_trace_id');
    expect(Object.keys(args).some((k) => k.includes('actor'))).toBe(false);
  });

  it('rejects a missing or non-uuid traceId without calling the RPC', async () => {
    await expect(writeAuditLog(valid({ traceId: '' }))).rejects.toThrow(/traceId/);
    await expect(writeAuditLog(valid({ traceId: 'not-a-uuid' }))).rejects.toThrow(/traceId/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects an action that is not snake_case or is too long', async () => {
    await expect(writeAuditLog(valid({ action: 'Post Stage' }))).rejects.toThrow(/action/);
    await expect(writeAuditLog(valid({ action: 'a'.repeat(101) }))).rejects.toThrow(/action/);
    await expect(writeAuditLog(valid({ action: '' }))).rejects.toThrow(/action/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects an invalid outcome', async () => {
    await expect(
      // Exercise the runtime guard past the compile-time union.
      writeAuditLog(valid({ outcome: 'maybe' as unknown as AuditWrite['outcome'] })),
    ).rejects.toThrow(/outcome/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects a payload over 64KB serialized', async () => {
    const payload = { blob: 'x'.repeat(64 * 1024) };
    await expect(writeAuditLog(valid({ payload }))).rejects.toThrow(/64KB/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('accepts a payload right at the 64KB boundary', async () => {
    // Serialized form is {"blob":"x...x"}; pad so the whole string is 65536 bytes.
    const filler = 'x'.repeat(64 * 1024 - '{"blob":""}'.length);
    await expect(writeAuditLog(valid({ payload: { blob: filler } }))).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('propagates an RPC error instead of swallowing it', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('rls denied') });
    await expect(writeAuditLog(valid())).rejects.toThrow(/rls denied/);
  });
});

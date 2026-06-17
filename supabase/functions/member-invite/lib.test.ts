import { describe, expect, it } from 'vitest';

import {
  buildAcceptUrl,
  inviteInputSchema,
  mapInviteRpcError,
  parseInviteInput,
  uuidv7,
} from './lib.ts';

describe('parseInviteInput', () => {
  it('accepts a valid payload and lower-cases the email', () => {
    const result = parseInviteInput({
      workspace_id: '11111111-1111-4111-8111-111111111111',
      email: 'Person@Example.COM',
      role: 'agency',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe('person@example.com');
      expect(result.data.role).toBe('agency');
    }
  });

  it.each(['admin', 'agency', 'client'] as const)('accepts role %s', (role) => {
    const result = parseInviteInput({
      workspace_id: '11111111-1111-4111-8111-111111111111',
      email: 'a@b.com',
      role,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-uuid workspace_id', () => {
    const result = parseInviteInput({ workspace_id: 'nope', email: 'a@b.com', role: 'admin' });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed email', () => {
    const result = parseInviteInput({
      workspace_id: '11111111-1111-4111-8111-111111111111',
      email: 'not-an-email',
      role: 'admin',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an out-of-range role (owner is not invitable)', () => {
    const result = parseInviteInput({
      workspace_id: '11111111-1111-4111-8111-111111111111',
      email: 'a@b.com',
      role: 'owner',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys via strict()', () => {
    const result = inviteInputSchema.safeParse({
      workspace_id: '11111111-1111-4111-8111-111111111111',
      email: 'a@b.com',
      role: 'admin',
      extra: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-object body', () => {
    expect(parseInviteInput(null).success).toBe(false);
    expect(parseInviteInput('string').success).toBe(false);
  });
});

describe('mapInviteRpcError', () => {
  it('maps workspace_member_only to 403', () => {
    expect(mapInviteRpcError('workspace_member_only')).toEqual({
      code: 'workspace_member_only',
      status: 403,
    });
  });

  it('maps forbidden_role to 403', () => {
    expect(mapInviteRpcError('forbidden_role')).toEqual({
      code: 'forbidden_role',
      status: 403,
    });
  });

  it('maps invalid_payload to 400', () => {
    expect(mapInviteRpcError('invalid_payload')).toEqual({
      code: 'invalid_payload',
      status: 400,
    });
  });

  it('maps anything else to internal_error 500', () => {
    expect(mapInviteRpcError('some unexpected postgres error')).toEqual({
      code: 'internal_error',
      status: 500,
    });
  });

  it('matches the code even when wrapped in extra text', () => {
    expect(mapInviteRpcError('ERROR: forbidden_role (SQLSTATE P0001)').code).toBe('forbidden_role');
  });
});

describe('buildAcceptUrl', () => {
  it('builds the accept url from APP_URL and the invite id', () => {
    expect(buildAcceptUrl('https://app.sorted.test', 'abc-123')).toBe(
      'https://app.sorted.test/invite/accept?invite=abc-123',
    );
  });

  it('normalises a trailing slash on the base', () => {
    expect(buildAcceptUrl('https://app.sorted.test/', 'abc-123')).toBe(
      'https://app.sorted.test/invite/accept?invite=abc-123',
    );
  });

  it('url-encodes the invite id', () => {
    expect(buildAcceptUrl('https://app.sorted.test', 'a b/c')).toBe(
      'https://app.sorted.test/invite/accept?invite=a%20b%2Fc',
    );
  });
});

describe('uuidv7', () => {
  const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('produces a well-formed version-7 uuid', () => {
    expect(uuidv7()).toMatch(UUID_V7);
  });

  it('is deterministic for a fixed timestamp and random bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const id = uuidv7(0x0123456789ab, bytes);
    expect(id).toMatch(UUID_V7);
    // 48-bit timestamp is encoded big-endian into the first six bytes.
    expect(id.startsWith('01234567-89ab-7')).toBe(true);
  });

  it('sets the version nibble to 7 and the variant to 10xx', () => {
    const id = uuidv7(Date.now(), new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('rejects too few random bytes', () => {
    expect(() => uuidv7(0, new Uint8Array([1, 2, 3]))).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { GENERIC_ERROR, plainError } from '@/lib/error-copy';

const RAW_TEXTS = [
  'PGRST301: JWT expired',
  'permission denied for table posts',
  'relation "public.secret_table" does not exist',
  'new row violates row-level security policy for table "posts"',
  'duplicate key value violates unique constraint "posts_pkey"',
  "TypeError: Cannot read properties of undefined (reading 'id')",
  'rpc 500 internal',
  '<html><body>502 Bad Gateway</body></html>',
];

describe('plainError', () => {
  it('maps the known domain codes to plain sentences', () => {
    expect(plainError('forbidden_role')).toBe("You don't have permission to do that.");
    expect(plainError('invalid_payload')).toBe(
      "Something in that request wasn't right. Check it and try again.",
    );
    expect(plainError('not authenticated')).toBe('Your session has ended. Sign in again.');
    expect(plainError('not_authenticated')).toBe('Your session has ended. Sign in again.');
    expect(plainError('network_failure')).toBe(
      "You're offline or the connection dropped. Check your network and try again.",
    );
    expect(plainError('timeout')).toBe('That took too long. Try again.');
  });

  it('reads a DomainError or PostgREST error object by its code, then its message', () => {
    expect(plainError({ code: 'forbidden_role', message: 'nope' })).toBe(
      "You don't have permission to do that.",
    );
    expect(plainError({ code: 'unknown', message: 'forbidden_role' })).toBe(
      "You don't have permission to do that.",
    );
    const statementTimeout = {
      code: '57014',
      message: 'canceling statement due to statement timeout',
    };
    expect(plainError(statementTimeout)).toBe('That took too long. Try again.');
  });

  it('reads the transport failures a phone meets from an Error', () => {
    expect(plainError(new TypeError('Failed to fetch'))).toBe(
      "You're offline or the connection dropped. Check your network and try again.",
    );
    expect(plainError(new TypeError('Load failed'))).toBe(
      "You're offline or the connection dropped. Check your network and try again.",
    );
    const abort = new Error('The operation was aborted.');
    abort.name = 'AbortError';
    expect(plainError(abort)).toBe('That took too long. Try again.');
  });

  it('never returns raw PostgREST or exception text', () => {
    for (const raw of RAW_TEXTS) {
      for (const input of [raw, new Error(raw), { code: 'PGRST301', message: raw }]) {
        const out = plainError(input);
        expect(out).toBe(GENERIC_ERROR);
        expect(out).not.toContain(raw);
      }
    }
    expect(plainError(undefined)).toBe(GENERIC_ERROR);
    expect(plainError(null)).toBe(GENERIC_ERROR);
    expect(plainError(42)).toBe(GENERIC_ERROR);
    expect(plainError('')).toBe(GENERIC_ERROR);
  });

  it('every sentence is plain: no em-dash, no code, no stack', () => {
    const all = new Set<string>();
    for (const input of ['forbidden_role', 'invalid_payload', 'timeout', 'network_failure', 'x']) {
      all.add(plainError(input));
    }
    for (const sentence of all) {
      expect(sentence).not.toContain('—');
      expect(sentence).not.toMatch(/_|PGRST|\bat\s+\w+\s*\(/);
      expect(sentence.endsWith('.')).toBe(true);
    }
  });
});

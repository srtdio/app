import { describe, expect, it } from 'vitest';

import { serializeError } from './serialize-error';

describe('serializeError', () => {
  it('keeps name and message for Error instances', () => {
    const out = serializeError(new TypeError('boom'));
    expect(out).toContain('TypeError: boom');
  });

  it('keeps structured fields for Supabase-style error objects', () => {
    const out = serializeError({ code: '23505', message: 'duplicate key value', hint: null });
    expect(out).toContain('23505');
    expect(out).toContain('duplicate key value');
  });

  it('stringifies primitives', () => {
    expect(serializeError('plain')).toBe('plain');
  });
});

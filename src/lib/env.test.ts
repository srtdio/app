import { describe, expect, it } from 'vitest';
import { envSchema } from '@/lib/env';

// Minimal set of required vars so the schema parses; optional URL vars are
// layered on per-case below.
const base = {
  VITE_SUPABASE_URL: 'https://test.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_000000000000',
};

describe('envSchema optional URL vars', () => {
  it.each(['VITE_CHAT_TOKEN_URL', 'VITE_ASSET_READ_URL', 'VITE_ASSET_UPLOAD_URL'])(
    'treats an empty %s as undefined (no throw)',
    (key) => {
      const result = envSchema.safeParse({ ...base, [key]: '' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data[key as keyof typeof result.data]).toBeUndefined();
      }
    },
  );

  it('preserves a valid https URL value', () => {
    const result = envSchema.safeParse({
      ...base,
      VITE_CHAT_TOKEN_URL: 'https://chat.example.com/token',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.VITE_CHAT_TOKEN_URL).toBe('https://chat.example.com/token');
    }
  });

  it('still rejects a non-empty invalid value (validation not loosened)', () => {
    const result = envSchema.safeParse({ ...base, VITE_CHAT_TOKEN_URL: 'notaurl' });
    expect(result.success).toBe(false);
  });
});

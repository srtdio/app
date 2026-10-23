import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', () => ({ env: { VITE_ASSET_READ_URL: 'https://read.test' } }));
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));
vi.mock('@/lib/fetch', () => ({ fetchWithTrace: vi.fn() }));

const { defaultFileBase } = await import('@/lib/shared-presign');

describe('defaultFileBase', () => {
  it('turns fast file links on for srtd.io and its test / preview sites', () => {
    expect(defaultFileBase('srtd.io')).toBe('https://srtd.io');
    expect(defaultFileBase('test.srtdio-app.pages.dev')).toBe('https://srtd.io');
    expect(defaultFileBase('srtdio-app.pages.dev')).toBe('https://srtd.io');
  });

  it('keeps the per-file path anywhere else (local dev, the e2e harness)', () => {
    expect(defaultFileBase('localhost')).toBeNull();
    expect(defaultFileBase('127.0.0.1')).toBeNull();
    expect(defaultFileBase('srtd.io.evil.example')).toBeNull();
    expect(defaultFileBase('notsrtdio-app.pages.dev')).toBeNull();
    expect(defaultFileBase(null)).toBeNull();
  });
});

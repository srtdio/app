// Supabase CLI services every DB suite skips on `supabase start -x`. One list so
// the setup files and the CI image cache key (.github/actions/supabase-images
// hashes this file) agree on which images the stack needs.

// Heavy/unstartable containers excluded by every suite.
export const SUPABASE_EXCLUDE_BASE = [
  'edge-runtime',
  'studio',
  'imgproxy',
  'storage-api',
  'realtime',
  'vector',
  'logflare',
  'supavisor',
  'postgres-meta',
] as const;

// Suites that never send mail also skip the mail catcher. The auth suite keeps it.
export const SUPABASE_EXCLUDE = [...SUPABASE_EXCLUDE_BASE, 'mailpit'].join(',');
export const SUPABASE_EXCLUDE_WITH_MAIL = SUPABASE_EXCLUDE_BASE.join(',');

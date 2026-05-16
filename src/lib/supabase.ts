import { createClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';

export const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  // Route every Supabase request through fetchWithTrace so it carries X-Trace-Id.
  global: {
    fetch: (input, init) => fetchWithTrace(input, init),
  },
});

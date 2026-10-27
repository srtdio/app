// The Cockpit's one network door: GET the ops-cockpit edge function with the
// operator's own access token. Imported only from the lazy Cockpit chunk, so
// it never loads for anyone else.

import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { supabase } from '@/lib/supabase';
import type { CockpitFull, CockpitStatus, CockpitTab } from '@/lib/cockpit/types';

export const COCKPIT_FUNCTION = 'ops-cockpit';

export function cockpitUrl(params: Record<string, string>): string {
  const base = env.VITE_SUPABASE_URL.replace(/\/+$/, '');
  return `${base}/functions/v1/${COCKPIT_FUNCTION}?${new URLSearchParams(params).toString()}`;
}

async function get<T>(params: Record<string, string>): Promise<T> {
  // The session the client already holds (no network read).
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token === undefined) throw new Error('no session');
  const response = await fetchWithTrace(cockpitUrl(params), {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY,
    },
  });
  if (!response.ok) throw new Error(`ops-cockpit ${response.status.toString()}`);
  return (await response.json()) as T;
}

/** The dot only. */
export function fetchCockpitStatus(): Promise<CockpitStatus> {
  return get<CockpitStatus>({ mode: 'status' });
}

/** One tab plus every tile; open marks an open or a tab pick (one access-log row). */
export function fetchCockpitFull(tab: CockpitTab, open: boolean): Promise<CockpitFull> {
  return get<CockpitFull>({ mode: 'full', tab, ...(open ? { open: '1' } : {}) });
}

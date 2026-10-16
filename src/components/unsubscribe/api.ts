import { UNSUBSCRIBE_FUNCTION_NAME } from '@srtdio/inbox';
import type { UnsubscribeJsonRequest, UnsubscribeStatus } from '@srtdio/inbox';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';

function functionUrl(): string {
  return `${env.VITE_SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/${UNSUBSCRIBE_FUNCTION_NAME}`;
}

function parseStatus(body: unknown): UnsubscribeStatus | null {
  if (typeof body !== 'object' || body === null) return null;
  const subscribed: unknown = (body as Record<string, unknown>).subscribed;
  return typeof subscribed === 'boolean' ? { subscribed } : null;
}

async function readStatus(res: Response): Promise<UnsubscribeStatus | null> {
  if (!res.ok) return null;
  try {
    return parseStatus(await res.json());
  } catch {
    return null;
  }
}

/** GET status. Never writes. null = invalid link (404, bad body, or network failure). */
export async function fetchUnsubscribeStatus(
  u: string,
  t: string,
): Promise<UnsubscribeStatus | null> {
  const url = new URL(functionUrl());
  url.searchParams.set('u', u);
  url.searchParams.set('t', t);
  try {
    const res = await fetchWithTrace(url, {
      method: 'GET',
      headers: { apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY },
    });
    return await readStatus(res);
  } catch {
    return null;
  }
}

/** POST unsubscribe / resubscribe. null = the change did not go through. */
export async function postUnsubscribeAction(
  request: UnsubscribeJsonRequest,
): Promise<UnsubscribeStatus | null> {
  try {
    const res = await fetchWithTrace(functionUrl(), {
      method: 'POST',
      headers: {
        apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    return await readStatus(res);
  } catch {
    return null;
  }
}

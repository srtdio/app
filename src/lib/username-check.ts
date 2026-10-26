// The live @username check shared by onboarding and Settings. A check can reach
// the server without the person's sign-in attached (the session was being
// renewed at that moment), and the server then refuses it. That is not an answer
// about the name, so the check renews the session and asks once more before it
// reports 'error'. Two people can never end up with the same name either way:
// the database keeps usernames unique and the save says username_taken.

import { usernameAvailable } from '@srtdio/rpc';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';

type UsernameCheck = 'free' | 'taken' | 'error';

/** Ask once; null when the server gave no answer. */
async function askOnce(value: string, traceId: string): Promise<boolean | null> {
  const res = await usernameAvailable(supabase, { p_username: value, p_trace_id: traceId });
  if (res.ok) return res.data;
  logger.warn('username check refused', { error: res.error.message });
  return null;
}

export async function checkUsername(value: string, newTrace: () => string): Promise<UsernameCheck> {
  const first = await askOnce(value, newTrace());
  if (first !== null) return first ? 'free' : 'taken';
  // getSession renews an expired sign-in before the second ask.
  const { data } = await supabase.auth.getSession();
  if (data.session === null) return 'error';
  const second = await askOnce(value, newTrace());
  if (second === null) {
    logger.error('username check failed twice', { username_length: value.length });
    return 'error';
  }
  return second ? 'free' : 'taken';
}

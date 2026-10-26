// The test site (test.srtdio-app.pages.dev) gets quick testers: one tap makes a
// throwaway account, and an invite to a test address opens as that invitee, with
// no email. The database refuses both anywhere else (test_session_create checks
// the request Origin); this check only decides whether the buttons show.

import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';

const TEST_SITE_HOST = 'test.srtdio-app.pages.dev';
const TEST_EMAIL_DOMAIN = 'test.srtd.io';

export function isTestSite(
  host: string = typeof window === 'undefined' ? '' : window.location.hostname,
): boolean {
  return host === TEST_SITE_HOST;
}

export function isTestEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${TEST_EMAIL_DOMAIN}`);
}

/** A fresh test address for an invite, e.g. approver-3fa9@test.srtd.io. */
export function testAddress(prefix: string): string {
  const tag = Math.random().toString(16).slice(2, 6);
  return `${prefix}-${tag}@${TEST_EMAIL_DOMAIN}`;
}

interface TestSession {
  email: string;
  password: string;
  invite_id: string | null;
}

/**
 * Signs in as a brand-new test account (email null) or as the pending test
 * invitee at `email`. Any current session is signed out first. Resolves to the
 * invite id for an invitee (null otherwise); throws with the server's message.
 */
export async function startTestSession(email: string | null): Promise<string | null> {
  const args = { p_email: email as string, p_trace_id: generateTraceId() };
  const { data, error } = await supabase.rpc('test_session_create', args);
  if (error) throw new Error(error.message);
  const session = data as unknown as TestSession;
  await supabase.auth.signOut({ scope: 'local' });
  const signedIn = await supabase.auth.signInWithPassword({
    email: session.email,
    password: session.password,
  });
  if (signedIn.error) throw new Error(signedIn.error.message);
  return session.invite_id;
}

const INVITEES_KEY = 'srtdio.test.invitees';

interface TestInvitee {
  email: string;
  at: number;
}

/** Test invitees this browser invited, newest first (for the sign-in page's buttons). */
export function readTestInvitees(): TestInvitee[] {
  try {
    const raw = window.localStorage.getItem(INVITEES_KEY);
    const list = raw === null ? [] : (JSON.parse(raw) as TestInvitee[]);
    return Array.isArray(list) ? list.filter((i) => isTestEmail(i.email)).slice(0, 5) : [];
  } catch {
    return [];
  }
}

export function rememberTestInvitee(email: string): void {
  try {
    const rest = readTestInvitees().filter((i) => i.email !== email.toLowerCase());
    const next = [{ email: email.toLowerCase(), at: Date.now() }, ...rest].slice(0, 5);
    window.localStorage.setItem(INVITEES_KEY, JSON.stringify(next));
  } catch {
    // Storage off: the link under the invite form still works.
  }
}

/** The page that signs in as a test invitee and opens their invite. */
export function testInviteePath(email: string): string {
  return `/test/invitee/${encodeURIComponent(email.toLowerCase())}`;
}

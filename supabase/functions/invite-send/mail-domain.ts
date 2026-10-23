// Mail-record check for an invitee's email domain, over DNS-over-HTTPS (JSON API).
// Self-contained: no @srtdio/* imports (see index.ts for why).
//
// 'ok'      the domain has an MX record, or no MX but an A record (RFC 5321 5.1
//           implicit MX fallback).
// 'no_mail' the domain does not exist (NXDOMAIN) or has neither MX nor A.
// 'unknown' the lookup itself failed (network, non-200, timeout, bad body).
//           Callers must not block on it. This function never throws.

export const DEFAULT_MAIL_DNS_URL = 'https://cloudflare-dns.com/dns-query';

export type MailDomainResult = 'ok' | 'no_mail' | 'unknown';

export interface MailDomainDeps {
  fetch: typeof fetch;
  timeoutMs: number;
  /** DoH endpoint; MAIL_DNS_URL env, else DEFAULT_MAIL_DNS_URL. */
  dnsUrl?: string;
}

const DNS_STATUS_NOERROR = 0;
const DNS_STATUS_NXDOMAIN = 3;
const DNS_TYPE_A = 1;
const DNS_TYPE_MX = 15;

interface DohAnswer {
  type?: unknown;
}

interface DohResponse {
  Status?: unknown;
  Answer?: unknown;
}

type Lookup = { status: number; types: number[] } | null;

async function lookup(domain: string, type: 'MX' | 'A', deps: MailDomainDeps): Promise<Lookup> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    const url = new URL(deps.dnsUrl ?? DEFAULT_MAIL_DNS_URL);
    url.searchParams.set('name', domain);
    url.searchParams.set('type', type);
    const response = await deps.fetch(url.toString(), {
      method: 'GET',
      headers: { accept: 'application/dns-json' },
      signal: controller.signal,
    });
    if (response.status !== 200) return null;
    const body = (await response.json()) as DohResponse;
    if (typeof body !== 'object' || body === null || typeof body.Status !== 'number') return null;
    const answers = Array.isArray(body.Answer) ? (body.Answer as DohAnswer[]) : [];
    const types = answers
      .map((answer) => answer?.type)
      .filter((value): value is number => typeof value === 'number');
    return { status: body.Status, types };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkMailDomain(
  domain: string,
  deps: MailDomainDeps,
): Promise<MailDomainResult> {
  const mx = await lookup(domain, 'MX', deps);
  if (!mx) return 'unknown';
  if (mx.status === DNS_STATUS_NXDOMAIN) return 'no_mail';
  if (mx.status !== DNS_STATUS_NOERROR) return 'unknown';
  if (mx.types.includes(DNS_TYPE_MX)) return 'ok';

  const a = await lookup(domain, 'A', deps);
  if (!a) return 'unknown';
  if (a.status === DNS_STATUS_NXDOMAIN) return 'no_mail';
  if (a.status !== DNS_STATUS_NOERROR) return 'unknown';
  return a.types.includes(DNS_TYPE_A) ? 'ok' : 'no_mail';
}

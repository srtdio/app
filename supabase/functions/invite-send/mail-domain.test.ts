import { describe, expect, it, vi } from 'vitest';
import { checkMailDomain, DEFAULT_MAIL_DNS_URL } from './mail-domain.ts';

type Answer = { Status: number; Answer?: { type: number }[] };

// A DoH stub answering per query type; a missing type answers NOERROR, empty.
function doh(byType: Partial<Record<'MX' | 'A', Answer>>) {
  return vi.fn(async (input: string | URL | Request) => {
    const type = new URL(String(input)).searchParams.get('type') as 'MX' | 'A';
    return new Response(JSON.stringify(byType[type] ?? { Status: 0 }), { status: 200 });
  });
}

function deps(fetchMock: ReturnType<typeof vi.fn>, timeoutMs = 2500) {
  return { fetch: fetchMock as unknown as typeof fetch, timeoutMs };
}

describe('checkMailDomain', () => {
  it('is ok with an MX answer, and asks the DoH JSON API', async () => {
    const f = doh({ MX: { Status: 0, Answer: [{ type: 15 }] } });
    expect(await checkMailDomain('gmail.com', deps(f))).toBe('ok');
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(DEFAULT_MAIL_DNS_URL);
    expect(parsed.searchParams.get('name')).toBe('gmail.com');
    expect(parsed.searchParams.get('type')).toBe('MX');
    expect(init.headers).toEqual({ accept: 'application/dns-json' });
  });

  it('is no_mail on NXDOMAIN', async () => {
    const f = doh({ MX: { Status: 3 } });
    expect(await checkMailDomain('gmial.con', deps(f))).toBe('no_mail');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('falls back to an A record when there is no MX', async () => {
    const f = doh({
      MX: { Status: 0, Answer: [{ type: 5 }] },
      A: { Status: 0, Answer: [{ type: 1 }] },
    });
    expect(await checkMailDomain('brand.com', deps(f))).toBe('ok');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('is no_mail with neither MX nor A', async () => {
    const f = doh({ MX: { Status: 0 }, A: { Status: 0, Answer: [] } });
    expect(await checkMailDomain('empty.example', deps(f))).toBe('no_mail');
  });

  it('is unknown on a timeout', async () => {
    const f = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    expect(await checkMailDomain('slow.example', deps(f, 10))).toBe('unknown');
  });

  it('is unknown on a non-200 answer', async () => {
    const f = vi.fn(async () => new Response('busy', { status: 503 }));
    expect(await checkMailDomain('brand.com', deps(f))).toBe('unknown');
  });

  it('is unknown on a network error or an unparseable body, and never throws', async () => {
    const thrown = vi.fn(async () => {
      throw new Error('network down');
    });
    expect(await checkMailDomain('brand.com', deps(thrown))).toBe('unknown');
    const garbage = vi.fn(async () => new Response('<html>', { status: 200 }));
    expect(await checkMailDomain('brand.com', deps(garbage))).toBe('unknown');
  });

  it('uses the configured DoH URL', async () => {
    const f = doh({ MX: { Status: 0, Answer: [{ type: 15 }] } });
    await checkMailDomain('gmail.com', { ...deps(f), dnsUrl: 'https://dns.example/resolve' });
    expect(String(f.mock.calls[0]?.[0])).toMatch(/^https:\/\/dns\.example\/resolve\?/);
  });
});

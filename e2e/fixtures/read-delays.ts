import type { Page } from '@playwright/test';

// Realistic per-read latency over the harness network (routes added after
// installHarnessNetwork run first and fall back to it), plus a per-read
// timeline in the page's own clock (Resource Timing), so a spec can say which
// read started when relative to the tap and which waited on which.

/** What one Supabase read is, by table, select and method. Pure. */
export function readName(method: string, url: URL): string {
  const path = url.pathname;
  if (path.startsWith('/rest/v1/rpc/')) return `rpc ${path.slice('/rest/v1/rpc/'.length)}`;
  const table = path.replace('/rest/v1/', '');
  const p = url.searchParams;
  if (table === 'chat_messages') {
    if (p.get('select') === 'shared_plan_ids') return 'shared_plan_ids';
    return 'chat_messages';
  }
  if (table === 'posts' && p.get('stage') === 'eq.review') {
    return method === 'HEAD' ? 'open posts count' : 'open posts';
  }
  if (table === 'briefs' && p.get('status') === 'eq.open') {
    return method === 'HEAD' ? 'open briefs count' : 'open briefs';
  }
  if (table === 'workspace_members' && (p.get('select') ?? '').trim() === 'role') {
    return 'viewer role';
  }
  return table;
}

/** The default delay: the messages page 300 ms, every other read 250 to 400 ms. */
export function realisticDelay(name: string): number {
  if (name === 'chat_messages') return 300;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 151;
  return 250 + h;
}

/**
 * Delay every Supabase read (REST and RPC) by `delayOf(name)` ms while on.
 * Returns a switch so a spec can turn the delays on only around the tap.
 */
export async function delaySupabaseReads(
  page: Page,
  delayOf: (name: string) => number = realisticDelay,
): Promise<{ setOn: (on: boolean) => void; setDelay: (fn: (name: string) => number) => void }> {
  let on = true;
  let fn = delayOf;
  await page.route(/\/rest\/v1\//, async (route) => {
    const request = route.request();
    const ms = on ? fn(readName(request.method(), new URL(request.url()))) : 0;
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    await route.fallback();
  });
  return {
    setOn: (value) => {
      on = value;
    },
    setDelay: (value) => {
      fn = value;
    },
  };
}

export interface ReadSpan {
  name: string;
  start: number;
  end: number;
}

/** Every Supabase read since `since` (page clock), with start and end. */
export async function readSpans(page: Page, since: number): Promise<ReadSpan[]> {
  const raw = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter((e) => e.name.includes('/rest/v1/'))
      .map((e) => {
        const r = e as PerformanceResourceTiming;
        return { url: r.name, start: r.startTime, end: r.responseEnd };
      }),
  );
  return raw
    .filter((r) => r.start >= since)
    .map((r) => {
      const url = new URL(r.url);
      // HEAD and GET share a URL: a head-only count asks for count=exact with
      // no rows, which the timeline tells apart by the select (id only).
      const head = url.searchParams.get('select') === 'id' && /posts|briefs/.test(url.pathname);
      return {
        name: readName(head ? 'HEAD' : 'GET', url),
        start: Math.round(r.start - since),
        end: Math.round(r.end - since),
      };
    })
    .sort((a, b) => a.start - b.start);
}

/**
 * Which reads waited on which: a read that starts within 30 ms after another
 * read ends (and after the tap's first wave) follows it. Pure.
 */
export function dependencyChain(spans: readonly ReadSpan[]): string[] {
  const firstWave = Math.min(...spans.map((s) => s.start));
  const out: string[] = [];
  for (const s of spans) {
    if (s.start - firstWave < 30) {
      out.push(`${s.name} @${s.start} (tap wave)`);
      continue;
    }
    const after = spans
      .filter((p) => p !== s && p.end <= s.start + 2 && s.start - p.end < 30)
      .map((p) => p.name);
    out.push(`${s.name} @${s.start} after ${after.length > 0 ? after.join(' | ') : '?'}`);
  }
  return out;
}

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));

vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) },
  },
}));
vi.mock('@/lib/env', () => ({
  env: { VITE_SUPABASE_URL: 'https://sb.test/', VITE_SUPABASE_PUBLISHABLE_KEY: 'pk' },
}));
vi.mock('@/lib/fetch', () => ({ fetchWithTrace: mockFetch }));

import { BookCallSheet } from './BookCallSheet';
import { ContactSheet, contactClipboardText } from './ContactSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

async function render(node: React.ReactNode): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  );
  if (found === undefined) throw new Error(`no button "${text}"`);
  return found;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-17T10:00:00Z'));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  mockFetch.mockReset();
  vi.useRealTimers();
});

describe('BookCallSheet', () => {
  it('shows three slots and Another day or time; Book waits for a choice', async () => {
    await render(<BookCallSheet open onClose={() => undefined} workspaceId="ws-1" />);
    expect(document.body.textContent).toContain(
      'Pick a time. We send a Google Meet link to your email.',
    );
    const rows = [...document.querySelectorAll('[role="radio"]')].map((r) => r.textContent);
    expect(rows).toHaveLength(4);
    expect(rows[3]).toBe('Another day or time');
    expect(button('Book').disabled).toBe(true);

    await act(async () => button('Another day or time').click());
    expect(document.body.textContent).toContain('Your time zone. We confirm by email.');
    const date = document.querySelector<HTMLInputElement>('input[type="date"]')!;
    const time = document.querySelector<HTMLInputElement>('input[type="time"]')!;
    expect(time.step).toBe('900');
    expect(date.min).not.toBe('');
    await type(date, '2026-10-21');
    expect(button('Book').disabled).toBe(true);
    await type(time, '14:15');
    expect(button('Book').disabled).toBe(false);

    await act(async () => (document.querySelector('[role="radio"]') as HTMLButtonElement).click());
    expect(button('Book').disabled).toBe(false);
  });

  it('POSTs the slot with bearer, apikey and zone, then says Booked', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    await render(<BookCallSheet open onClose={() => undefined} workspaceId="ws-1" />);
    const first = document.querySelector<HTMLButtonElement>('[role="radio"]')!;
    const label = first.textContent ?? '';
    await act(async () => first.click());
    await act(async () => button('Book').click());
    await settle();

    const [url, init, trace] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://sb.test/functions/v1/book-call-send');
    expect(trace).toBe('trace-1');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(headers.apikey).toBe('pk');
    const body = JSON.parse(String((init as RequestInit).body)) as Record<string, string>;
    expect(body.workspace_id).toBe('ws-1');
    expect(body.slot_at).toMatch(/Z$/);
    expect(body.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);

    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Booked');
    expect(document.body.textContent).toContain(
      `${label}. The team sends a Google Meet link to your email before the call.`,
    );
    expect(button('Done')).toBeTruthy();
  });

  it('a failure stays inline and Book comes back', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 500 }));
    await render(<BookCallSheet open onClose={() => undefined} workspaceId="ws-1" />);
    await act(async () => (document.querySelector('[role="radio"]') as HTMLButtonElement).click());
    await act(async () => button('Book').click());
    await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Couldn't send. Try again.");
    expect(button('Book').disabled).toBe(false);
  });
});

describe('ContactSheet', () => {
  it('shows the address, the suggested line and a prefilled mailto', async () => {
    await render(<ContactSheet open onClose={() => undefined} workspaceName="Acme - LinkedIn" />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Tell us what you need. Someone from the team replies by email.');
    expect(text).toContain('support@srtd.io');
    expect(text).toContain('Suggested line, copied with the address:');
    expect(text).toContain("Hi, I'm on Acme - LinkedIn and need another workspace.");
    const mail = [...document.querySelectorAll('a')].find((a) => a.textContent === 'Open email');
    expect(mail?.getAttribute('href')).toMatch(/^mailto:support@srtd\.io\?/);
    expect(contactClipboardText('Acme')).toBe(
      "support@srtd.io\nHi, I'm on Acme and need another workspace.",
    );
  });
});

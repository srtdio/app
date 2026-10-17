// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LinkPreviewCard, formatDuration, type CardTone } from '@/components/ui/LinkPreviewCard';
import { createPreviewClient, type LinkPreview, type PreviewClient } from '@/lib/links/preview';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = { finalDomain: null, viaShortener: null };

const ANSWERS: Record<string, LinkPreview> = {
  full: {
    type: 'full',
    domain: 'instagram.com',
    path: '/p/C9x2',
    letter: 'I',
    ...BASE,
    title: 'Northwind Foods on Instagram',
    description: 'Our Diwali range ships from 20 Oct.',
    siteName: 'Instagram',
    video: false,
    durationSeconds: null,
  },
  video: {
    type: 'full',
    domain: 'youtube.com',
    path: '/watch?v=1',
    letter: 'Y',
    ...BASE,
    title: 'How we pack 10,000 hampers a day',
    description: null,
    siteName: 'YouTube',
    video: true,
    durationSeconds: 134,
  },
  text: {
    type: 'text',
    domain: 'canva.com',
    path: '/design/DAF1',
    letter: 'C',
    finalDomain: 'canva.com',
    viaShortener: 'bit.ly',
    title: 'Diwali carousel v4',
    description: null,
    siteName: null,
    video: false,
    durationSeconds: null,
  },
  login: {
    type: 'login',
    domain: 'drive.google.com',
    path: '/file/d/1aX9/view',
    letter: 'D',
    ...BASE,
  },
  bare: { type: 'bare', domain: 'example.com', path: '/a/b', letter: 'E', ...BASE },
};

const URLS: Record<string, string> = {
  full: 'https://www.instagram.com/p/C9x2',
  video: 'https://www.youtube.com/watch?v=1',
  text: 'https://bit.ly/3xYz',
  login: 'https://drive.google.com/file/d/1aX9/view',
  bare: 'https://example.com/a/b',
};

const UNSAFE_URL = 'http://g00gle-docs-share.top:8080/login?next=x';

/** A real client over a fetcher the test answers by hand. */
function controlledClient() {
  const waiting: Array<{ url: string; resolve: (r: Response) => void }> = [];
  const client = createPreviewClient({
    endpoint: 'https://lp.example',
    getToken: async () => 'jwt',
    fetcher: (url) => new Promise<Response>((resolve) => waiting.push({ url, resolve })),
  });
  const answer = async (kind: string): Promise<void> => {
    await act(async () => {
      for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
    const next = waiting.shift();
    expect(next).toBeDefined();
    await act(async () => {
      next?.resolve(new Response(JSON.stringify(ANSWERS[kind]), { status: 200 }));
      for (let i = 0; i < 3; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  return { client, answer, waiting };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(
  url: string,
  client: PreviewClient,
  opts: {
    tone?: CardTone;
    theme?: 'light' | 'dark';
    size?: 'full' | 'compact' | 'draft';
    onRemove?: () => void;
  } = {},
): Promise<HTMLElement> {
  host = document.createElement('div');
  if (opts.theme === 'dark') host.className = 'dark';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <LinkPreviewCard
        url={url}
        client={client}
        tone={opts.tone ?? 'in'}
        size={opts.size ?? 'full'}
        {...(opts.onRemove !== undefined ? { onRemove: opts.onRemove } : {})}
      />,
    );
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

/** Sizing classes of the reserved box in DOM order: picture box + the three body slots. */
function boxSignature(el: Element): string[] {
  const out: string[] = [];
  for (const node of el.querySelectorAll('[class]')) {
    for (const cls of (node.getAttribute('class') ?? '').split(/\s+/)) {
      if (/^(aspect-\[1\.91\/1\]|h-4|h-8|h-9|h-16)$/.test(cls)) out.push(cls);
    }
  }
  return out;
}

function cardType(el: Element): string | null {
  return el.querySelector('[data-card-type]')?.getAttribute('data-card-type') ?? null;
}

describe('LinkPreviewCard', () => {
  it.each(['full', 'video', 'text', 'login', 'bare'])(
    '%s: skeleton box == final box, in and out bubbles, light and dark',
    async (kind) => {
      const markup: string[] = [];
      for (const tone of ['in', 'out'] as const) {
        for (const theme of ['light', 'dark'] as const) {
          const { client, answer } = controlledClient();
          const el = await mount(URLS[kind] ?? '', client, { tone, theme });
          expect(cardType(el)).toBe('skeleton');
          const before = boxSignature(el);
          await answer(kind);
          expect(cardType(el)).toBe(ANSWERS[kind]?.type);
          expect(boxSignature(el)).toEqual(before);
          markup.push(el.innerHTML);
          act(() => root?.unmount());
          host?.remove();
        }
      }
      // Token-only styling: the theme class never changes the card's markup,
      // and no hex colour or dark: literal is ever used.
      expect(markup[0]).toBe(markup[1]);
      expect(markup[2]).toBe(markup[3]);
      for (const html of markup) {
        expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        expect(html).not.toContain('dark:');
      }
    },
  );

  it('full: picture via /image, lazy + async, opens in a new tab with noopener noreferrer', async () => {
    const { client, answer } = controlledClient();
    const el = await mount(URLS.full ?? '', client);
    await answer('full');
    const a = el.querySelector('a');
    expect(a?.getAttribute('href')).toBe(URLS.full);
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
    const img = el.querySelector('img');
    expect(img?.getAttribute('src')).toBe(
      `https://lp.example/image?url=${encodeURIComponent('https://www.instagram.com/p/C9x2')}`,
    );
    expect(img?.getAttribute('loading')).toBe('lazy');
    expect(img?.getAttribute('decoding')).toBe('async');
    expect(el.textContent).toContain('Northwind Foods on Instagram');
    expect(el.textContent).toContain('instagram.com');
  });

  it('a failed picture becomes the letter tile inside the same box', async () => {
    const { client, answer } = controlledClient();
    const el = await mount(URLS.full ?? '', client);
    await answer('full');
    const before = boxSignature(el);
    await act(async () => {
      el.querySelector('img')?.dispatchEvent(new Event('error'));
    });
    expect(el.querySelector('img')).toBeNull();
    expect(boxSignature(el)).toEqual(before);
  });

  it('video: play badge and duration in the site row', async () => {
    const { client, answer } = controlledClient();
    const el = await mount(URLS.video ?? '', client);
    await answer('video');
    expect(el.textContent).toContain('youtube.com · 2:14');
    expect(formatDuration(3723)).toBe('1:02:03');
  });

  it('shortener: "bit.ly → canva.com"', async () => {
    const { client, answer } = controlledClient();
    const el = await mount(URLS.text ?? '', client);
    await answer('text');
    expect(el.textContent).toContain('bit.ly → canva.com');
  });

  it('login: "Sign-in needed to preview" only for login, never for bare', async () => {
    const a = controlledClient();
    const login = await mount(URLS.login ?? '', a.client);
    await a.answer('login');
    expect(login.textContent).toContain('Sign-in needed to preview');
    act(() => root?.unmount());
    const b = controlledClient();
    const bare = await mount(URLS.bare ?? '', b.client);
    await b.answer('bare');
    expect(bare.textContent).not.toContain('Sign-in');
    expect(bare.textContent).toContain('/a/b');
  });

  it('known at first paint (session cache): natural compact layout, no skeleton', async () => {
    const { client, answer } = controlledClient();
    await mount(URLS.login ?? '', client);
    await answer('login');
    act(() => root?.unmount());
    const el = await mount(URLS.login ?? '', client);
    expect(cardType(el)).toBe('login');
    expect(boxSignature(el)).toEqual(['h-16']);
  });

  it('missing Worker URL: bare compact card, nothing requested', async () => {
    const fetcher = vi.fn();
    const client = createPreviewClient({ endpoint: null, getToken: async () => 'jwt', fetcher });
    const el = await mount('https://example.com/a/b', client);
    expect(cardType(el)).toBe('bare');
    expect(el.textContent).toContain('example.com');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('unsafe: warning card, never fetched; opens the sheet with "Don\'t open" focused', async () => {
    const { client, waiting } = controlledClient();
    const el = await mount(UNSAFE_URL, client, { tone: 'out' });
    expect(cardType(el)).toBe('unsafe');
    expect(el.textContent).toContain('This link may be unsafe');
    expect(el.textContent).toContain('g00gle-docs-share.top · tap to check');
    expect(waiting).toHaveLength(0);
    await act(async () => {
      el.querySelector<HTMLButtonElement>('button[data-card-type="unsafe"]')?.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    const sheet = document.querySelector('[role="dialog"]');
    expect(sheet?.textContent).toContain('Check before opening');
    expect(sheet?.querySelector('[data-unsafe-url]')?.textContent).toBe(UNSAFE_URL);
    expect(sheet?.textContent).toContain('Not a secure (https) link');
    expect(sheet?.textContent).toContain('Uses an unusual port');
    expect(document.activeElement?.hasAttribute('data-unsafe-dont-open')).toBe(true);
    const anyway = sheet?.querySelector('a[data-unsafe-open-anyway]');
    expect(anyway?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(anyway?.getAttribute('target')).toBe('_blank');
    expect(anyway?.getAttribute('href')).toBe(UNSAFE_URL);
  });

  it('draft: X calls onRemove', async () => {
    const { client, answer } = controlledClient();
    const onRemove = vi.fn();
    const el = await mount(URLS.full ?? '', client, { size: 'draft', onRemove });
    expect(boxSignature(el)).toEqual(['h-16']);
    await answer('full');
    expect(boxSignature(el)).toEqual(['h-16']);
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[data-card-remove]')?.click();
    });
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('long-press guard: no text selection or iOS callout on the card', async () => {
    const { client, answer } = controlledClient();
    const el = await mount(URLS.full ?? '', client);
    await answer('full');
    const cls = el.querySelector('a')?.getAttribute('class') ?? '';
    expect(cls).toContain('select-none');
    expect(cls).toContain('[-webkit-touch-callout:none]');
  });
});

describe('no HTML sinks in the new files', () => {
  it.each([
    'src/components/ui/LinkPreviewCard.tsx',
    'src/components/ui/UnsafeLinkSheet.tsx',
    'src/lib/links/preview.ts',
    'src/lib/links/safety.ts',
    'src/server/workers/link-preview.ts',
  ])('%s', (file) => {
    const src = readFileSync(file, 'utf8');
    expect(src).not.toContain('dangerouslySetInnerHTML');
    expect(src).not.toMatch(/\.innerHTML\s*=/);
  });
});

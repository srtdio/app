import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// AppLayout's import graph reaches the chat SDK; mock it so the pure chrome
// helpers import cleanly in node (mirrors MessageThread.test.tsx).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { isDetailRoute, isThreadRoute, shellChrome } from '@/components/shell/AppLayout';

// AppLayout pulls in router + workspace + profile + chat/inbox/toast providers and
// renders under a DOM-less vitest node environment, so mounting it cleanly is
// impractical and no existing shell harness covers it. This regression instead
// reads the source and asserts the page-content scroll <main> keeps BOTH axis
// rules: overflow-y-auto for vertical scrolling and overflow-x-hidden so the
// container can never drift sideways (the Activity filter-row bleed report). The
// internal overflow-x-auto scrollers are their own elements and are not asserted
// here.
const source = readFileSync(fileURLToPath(new URL('./AppLayout.tsx', import.meta.url)), 'utf8');

describe('AppLayout page-content scroll container', () => {
  it('locks scrolling to the vertical axis on the <main> element', () => {
    expect(source).toContain('<main className={chrome.mainClassName}>');
    for (const threadOpen of [false, true]) {
      const className = shellChrome(threadOpen).mainClassName;
      expect(className).toContain('overflow-y-auto');
      expect(className).toContain('overflow-x-hidden');
    }
  });
});

// Below md is the mobile width; md and up must stay exactly as before. The class
// strings are what the browser applies at each width, so asserting them covers
// both widths without a DOM.
describe('AppLayout chat thread chrome', () => {
  const at = (url: string) => {
    const parsed = new URL(url, 'http://x');
    return shellChrome(isThreadRoute(parsed.pathname, parsed.searchParams));
  };

  it('/chat?channel=x hides the Topbar and BottomTabs at mobile width', () => {
    const chrome = at('/chat?channel=x');
    expect(chrome.topbarClassName.split(' ')).toContain('hidden');
    expect(chrome.showBottomTabs).toBe(false);
    expect(chrome.mainClassName).not.toContain('pb-[calc(84px');
  });

  it('/chat?channel=x keeps the Topbar at md and up', () => {
    expect(at('/chat?channel=x').topbarClassName.split(' ')).toContain('md:contents');
  });

  it('/chat without the param shows the chrome', () => {
    for (const url of ['/chat', '/chat?channel=', '/chat?w=abc']) {
      const chrome = at(url);
      expect(chrome.topbarClassName).toBe('contents');
      expect(chrome.showBottomTabs).toBe(true);
      expect(chrome.mainClassName).toContain('pb-[calc(84px+env(safe-area-inset-bottom))]');
      expect(chrome.mainClassName).toContain('md:pb-0');
    }
  });

  it('a channel param off /chat never hides the chrome', () => {
    expect(at('/pipeline?channel=x').showBottomTabs).toBe(true);
  });

  it('renders the Topbar wrapper and BottomTabs from the chrome, no effect or state', () => {
    expect(source).toContain('<div className={chrome.topbarClassName}>');
    expect(source).toContain('{chrome.showBottomTabs ? <BottomTabs /> : null}');
  });
});

// Post detail and Brief detail drop the phone chrome exactly as a chat thread does.
describe('AppLayout detail route chrome', () => {
  it('Post and Brief detail routes hide the Topbar and BottomTabs at mobile width', () => {
    for (const path of ['/posts/abc', '/p/ACME-12', '/briefs/abc', '/b/ACME-3']) {
      expect(isDetailRoute(path)).toBe(true);
      const chrome = shellChrome(isDetailRoute(path));
      expect(chrome.topbarClassName.split(' ')).toContain('hidden');
      expect(chrome.topbarClassName.split(' ')).toContain('md:contents');
      expect(chrome.showBottomTabs).toBe(false);
    }
  });

  it('list routes keep the chrome', () => {
    for (const path of ['/pipeline', '/briefs', '/posts', '/plan', '/plan/abc', '/assets']) {
      expect(isDetailRoute(path)).toBe(false);
    }
  });

  it('the shell derives the chrome from both the thread and the detail route', () => {
    expect(source).toContain(
      'shellChrome(isThreadRoute(pathname, searchParams) || isDetailRoute(pathname))',
    );
  });
});

// The Cockpit is the operator's only: for everyone else nothing renders, no
// chunk downloads and no request goes out. The source is the contract: the
// cockpit module is reachable only through React.lazy, and both lazy pieces
// mount only behind the operator flag the workspace context already reads.
describe('AppLayout Cockpit gate', () => {
  it('imports the cockpit only through React.lazy (no static import)', () => {
    expect(source).not.toMatch(/^import[^;]*@\/components\/cockpit/m);
    expect(source).not.toMatch(/^import[^;]*@\/lib\/cockpit/m);
    expect(source).toContain("import('@/components/cockpit/Cockpit')");
  });

  it('mounts the dot and the panel only for the operator', () => {
    expect(source).toContain('isPlatformOperator,\n  } = useWorkspace();');
    expect(source).toMatch(/isPlatformOperator\s*\?\s*\{\s*cockpitSlot:/);
    expect(source).toMatch(
      /\{isPlatformOperator \? \(\s*<Suspense fallback=\{null\}>\s*<CockpitPanel \/>/,
    );
    // Every lazy cockpit render sits behind the flag.
    const renders = source.match(/<Cockpit(Dot|Panel) \/>/g) ?? [];
    expect(renders).toHaveLength(2);
  });

  it('adds no read of its own: the flag is the one workspace-context already holds', () => {
    expect(source).not.toContain('platform_operators');
    expect(source).not.toContain('readIsPlatformOperator');
  });

  it('leaves <main> where it was: a direct child of the column, no wrapper', () => {
    expect(source).not.toContain('flex min-h-0 flex-1');
    expect(source).toMatch(/<\/main>\s*\{\/\* The operator's Cockpit panel/);
    for (const threadOpen of [false, true]) {
      expect(shellChrome(threadOpen).mainClassName).toContain('md:pr-[var(--side-panel-w,0px)]');
    }
  });
});

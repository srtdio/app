import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { HOME_STYLESHEET, runStaleDeployGuard, type StaleDeployDeps } from '@/lib/stale-deploy';
import { isGuestHome, type GuestPathInput } from './guest-path';
import { clipFor, mediaUrl, siteMediaBase } from './media';

vi.mock('@/lib/supabase', () => ({ supabase: { auth: {} } }));

import { homeRouteFor } from './HomeGate';

describe('homeRouteFor', () => {
  it('waits while the session resolves', () => {
    expect(homeRouteFor({ loading: true, signedIn: false })).toBe('loading');
  });
  it('sends signed-in users to the app', () => {
    expect(homeRouteFor({ loading: false, signedIn: true })).toBe('app');
  });
  it('shows the homepage to guests', () => {
    expect(homeRouteFor({ loading: false, signedIn: false })).toBe('home');
  });
});

describe('isGuestHome', () => {
  const input = (overrides: Partial<GuestPathInput> = {}): GuestPathInput => ({
    pathname: '/',
    search: '',
    hash: '',
    storageKeys: () => ['sorted-theme'],
    ...overrides,
  });

  it('takes the guest path on "/" with no stored session', () => {
    expect(isGuestHome(input())).toBe(true);
    expect(isGuestHome(input({ storageKeys: () => [] }))).toBe(true);
  });

  it('takes the app path when a Supabase auth token is stored', () => {
    expect(isGuestHome(input({ storageKeys: () => ['sb-x-auth-token'] }))).toBe(false);
    expect(
      isGuestHome(
        input({ storageKeys: () => ['sorted-theme', 'sb-movnexawfhsyuluspxoc-auth-token'] }),
      ),
    ).toBe(false);
  });

  it('ignores keys that only look similar', () => {
    expect(isGuestHome(input({ storageKeys: () => ['sb--auth-token', 'sb-x-auth-token-x'] }))).toBe(
      true,
    );
  });

  it('treats a throwing storage as no session', () => {
    const storageKeys = (): string[] => {
      throw new Error('SecurityError');
    };
    expect(isGuestHome(input({ storageKeys }))).toBe(true);
  });

  it.each(['/pipeline', '/signin', '/signup', '/auth/callback', '/legal/terms-and-conditions', ''])(
    'takes the app path on %s',
    (pathname) => {
      expect(isGuestHome(input({ pathname }))).toBe(false);
    },
  );

  it.each([
    ['search', '?code=abc'],
    ['search', '?x=1&code=abc'],
    ['search', '?type=recovery'],
    ['search', '?error_description=expired'],
    ['hash', '#access_token=a&refresh_token=b'],
    ['hash', '#refresh_token=b'],
    ['hash', '#type=signup'],
    ['hash', '#error_description=denied'],
  ] as const)('takes the app path for an auth callback in %s: %s', (where, value) => {
    expect(isGuestHome(input({ [where]: value }))).toBe(false);
  });

  it('does not mistake unrelated params for callbacks', () => {
    expect(isGuestHome(input({ search: '?utm_source=x&promo_code=y' }))).toBe(true);
  });
});

describe('media URLs', () => {
  const BASE = 'https://cdn.srtd.io/site/home/v1';

  it('builds manifest URLs when VITE_SITE_MEDIA_URL is set', () => {
    const base = siteMediaBase(BASE);
    expect(base).toBe(BASE);
    expect(mediaUrl(base, 'why-approvals.webp')).toBe(`${BASE}/why-approvals.webp`);
    expect(clipFor(base, 'problems-m')).toEqual({
      src: `${BASE}/problems-m.mp4`,
      poster: `${BASE}/problems-m.webp`,
      startAt: 0.167,
    });
  });

  it('starts clips that open on a real frame at 0', () => {
    const clip = clipFor(siteMediaBase(BASE), 'chat');
    expect(clip?.startAt ?? 0).toBe(0);
  });

  it('drops a trailing slash', () => {
    expect(siteMediaBase(`${BASE}/`)).toBe(BASE);
  });

  it.each([undefined, '', '   ', 'not a url', 'javascript:alert(1)'])(
    'omits media when the base is %j',
    (raw) => {
      const base = siteMediaBase(raw);
      expect(base).toBeNull();
      expect(mediaUrl(base, 'chat.webp')).toBeNull();
      expect(clipFor(base, 'chat')).toBeNull();
    },
  );
});

describe('homepage stale-deploy guard', () => {
  const css = readFileSync(fileURLToPath(new URL('./home.css', import.meta.url)), 'utf8');

  it('declares the probe token the guard reads', () => {
    expect(css).toMatch(new RegExp(`:root\\s*{\\s*${HOME_STYLESHEET.token}:\\s*1;`));
  });

  function deps(token: string, reload: (url: string) => void): StaleDeployDeps {
    return {
      stylesheet: null,
      isDocumentComplete: () => true,
      readToken: () => token,
      getHref: () => 'https://v2.srtd.io/',
      reload,
      replaceUrl: () => undefined,
      storage: () => {
        throw new Error('SecurityError');
      },
      now: () => 1,
      warn: () => undefined,
    };
  }

  it('renders when the homepage stylesheet applied', async () => {
    const reload = vi.fn<(url: string) => void>();
    await expect(runStaleDeployGuard(deps('1', reload))).resolves.toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads once when the homepage stylesheet is missing', async () => {
    const reload = vi.fn<(url: string) => void>();
    await expect(runStaleDeployGuard(deps('', reload))).resolves.toBe(false);
    expect(reload).toHaveBeenCalledWith('https://v2.srtd.io/?_r=1');
  });
});

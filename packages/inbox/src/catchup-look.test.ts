import { describe, expect, it } from 'vitest';
import { EMAIL_DARK, EMAIL_LIGHT, EMAIL_WORDMARK } from './email-shell';
import { renderCatchupEmail } from './catchup';
import type { RecipientDigest } from './catchup-contracts';

// Renders light and dark: the light look is inline on every element, the dark
// look is the shell's prefers-color-scheme block, and every shell class the
// html uses has a dark rule there. Pairs with src/__tests__/email-look.test.ts.
const SHELL_CLASSES = [
  'bg',
  'panel',
  'rowlink',
  'rule',
  'fg',
  'fg2',
  'fg3',
  'accent',
  'btn',
  'code',
  'wm-l',
  'wm-d',
];

function expectLight(html: string): void {
  expect(html).toMatch(/^<!doctype html>/);
  expect(html).toContain(`background:${EMAIL_LIGHT.bg}`);
  expect(html).toContain(`background:${EMAIL_LIGHT.panel}`);
  expect(html).toContain(
    `border:1px solid ${EMAIL_LIGHT.edge};border-top-color:${EMAIL_LIGHT.edgeTop};border-bottom:2px solid ${EMAIL_LIGHT.rim}`,
  );
  expect(html).toContain(`src="${EMAIL_WORDMARK.light}" width="64" height="24" alt="Sorted"`);
  expect(html).not.toMatch(/box-shadow/i);
}

function expectDark(html: string): void {
  expect(html).toContain('<meta name="color-scheme" content="light dark">');
  expect(html).toContain('<meta name="supported-color-schemes" content="light dark">');
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  expect(style).toContain('@media (prefers-color-scheme: dark)');
  expect(style).toContain(`.bg { background:${EMAIL_DARK.bg} !important; }`);
  expect(html).toContain(`src="${EMAIL_WORDMARK.dark}"`);
  const used = new Set(
    [...html.matchAll(/\bclass="([^"]*)"/g)].flatMap((m) => (m[1] ?? '').split(/\s+/)),
  );
  for (const cls of SHELL_CLASSES) if (used.has(cls)) expect(style, cls).toContain(`.${cls} {`);
}

function digest(over: Partial<RecipientDigest> = {}): RecipientDigest {
  return {
    userId: 'u1',
    workspaceId: 'w1',
    workspaceName: 'Acme',
    role: 'client',
    audience: 'client',
    slot: '10:30',
    local: { isoDate: '2026-10-19', weekday: 'Monday', day: 19, month: 'Oct' },
    previous: { slot: '15:30', weekday: 'Friday', sameDay: false },
    appBaseUrl: 'https://app.test',
    unsubscribeUrl: 'https://app.test/unsubscribe?u=u1&t=x',
    mentionNames: {},
    counts: { inReview: 12, unreadMessages: 3, comments: 0, approved: 0, parked: 0, newBriefs: 0 },
    review: { items: [], total: 0 },
    comments: { items: [], total: 0 },
    approved: { items: [], total: 0 },
    dms: { items: [], total: 0 },
    ...over,
  };
}

describe('catch-up email: light and dark', () => {
  const html = renderCatchupEmail(digest()).html;
  it('renders the light look', () => expectLight(html));
  it('renders the dark look', () => expectDark(html));

  it('stat tile numbers are mono with tabular figures', () => {
    expect(html).toMatch(
      /font-family:'JetBrains Mono'[^"]*font-variant-numeric:tabular-nums[^"]*">12</,
    );
  });

  it('the zero line is "You\'re all caught up."', () => {
    const zero = renderCatchupEmail(
      digest({
        counts: {
          inReview: 0,
          unreadMessages: 0,
          comments: 0,
          approved: 0,
          parked: 0,
          newBriefs: 0,
        },
      }),
    );
    expect(zero.html).toContain('You&#39;re all caught up.');
  });

  it('Unsubscribe is an underlined secondary link', () => {
    expect(html).toMatch(/<a [^>]*style="[^"]*text-decoration:underline"[^>]*>Unsubscribe<\/a>/);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { renderCatchupEmail } from '../../packages/inbox/src/catchup';
import type { RecipientDigest } from '../../packages/inbox/src/catchup-contracts';
import { inviteEmailBody } from '../../supabase/functions/invite-send/handler.ts';
import { brandRequestEmailBody } from '../../supabase/functions/brand-request-send/handler.ts';
import { requestEmailBody as bookCallBody } from '../../supabase/functions/book-call-send/mail.ts';
import { requestEmailBody as demoRequestBody } from '../../supabase/functions/demo-request-send/mail.ts';

// Visual lock for every email Sorted sends, light and dark (the email's own
// prefers-color-scheme block follows the project's colorScheme). Runs only in
// iphone-light and iphone-dark. The wordmark's https://srtd.io/email/... URLs
// are served from public/email so the shot never touches the network.

const EMAIL_PROJECTS = /^iphone-(light|dark)$/;

const digest: RecipientDigest = {
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
  counts: { inReview: 2, unreadMessages: 3, comments: 1, approved: 0, parked: 0, newBriefs: 0 },
  review: {
    items: [
      {
        postId: 'p1',
        title: 'Diwali carousel',
        url: 'https://app.test/p/p1',
        stageEnteredAt: '2026-10-18T09:00:00Z',
      },
      {
        postId: 'p2',
        title: 'Launch reel',
        url: 'https://app.test/p/p2',
        stageEnteredAt: '2026-10-17T09:00:00Z',
      },
    ],
    total: 2,
  },
  comments: { items: [], total: 0 },
  approved: { items: [], total: 0 },
  dms: { items: [], total: 0 },
};

const template = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../supabase/templates/${name}.html`, import.meta.url)),
    'utf8',
  )
    .replace('{{ .Token }}', '482913')
    .replace('{{ .Email }}', 'priya@example.test');

const EMAILS: readonly (readonly [string, () => string])[] = [
  [
    'email-invite',
    () =>
      inviteEmailBody({
        brand: 'Acme',
        displayName: 'Acme - Instagram',
        role: 'client',
        acceptUrl: 'https://app.test/accept',
      }).html,
  ],
  [
    'email-brand-request',
    () =>
      brandRequestEmailBody({
        requesterName: 'Priya',
        brandName: 'Acme',
        signUpUrl: 'https://app.test/signup',
      }).html,
  ],
  [
    'email-book-call',
    () =>
      bookCallBody({
        heading: 'New call booking',
        rows: [
          { label: 'Name', value: 'Priya Shah' },
          { label: 'Email', value: 'priya@example.test' },
          { label: 'Company', value: 'Acme' },
        ],
      }).html,
  ],
  [
    'email-demo-request',
    () =>
      demoRequestBody({
        heading: 'New demo request',
        rows: [
          { label: 'Name', value: 'Priya Shah' },
          { label: 'Email', value: 'priya@example.test' },
          { label: 'Team size', value: '6 to 20' },
        ],
      }).html,
  ],
  ['email-catchup', () => renderCatchupEmail(digest).html],
  [
    'email-catchup-zero',
    () =>
      renderCatchupEmail({
        ...digest,
        counts: {
          inReview: 0,
          unreadMessages: 0,
          comments: 0,
          approved: 0,
          parked: 0,
          newBriefs: 0,
        },
        review: { items: [], total: 0 },
      }).html,
  ],
  ['email-magic-link', () => template('magic-link')],
  ['email-confirm-signup', () => template('confirm-signup')],
];

for (const [name, render] of EMAILS) {
  test(name, async ({ page }, testInfo) => {
    test.skip(
      !EMAIL_PROJECTS.test(testInfo.project.name),
      'emails shoot on iPhone light and dark only',
    );
    await page.route('https://srtd.io/email/*', (route) =>
      route.fulfill({
        contentType: 'image/png',
        body: readFileSync(
          fileURLToPath(
            new URL(
              `../../public/email/${new URL(route.request().url()).pathname.split('/').pop()}`,
              import.meta.url,
            ),
          ),
        ),
      }),
    );
    await page.route(/^https?:\/\/(?!srtd\.io\/email\/)/, (route) => route.abort());
    await page.setContent(render(), { waitUntil: 'load' });
    await page.evaluate(() =>
      Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))),
    );
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
  });
}

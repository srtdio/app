import { describe, expect, it } from 'vitest';
import { EMAIL_DARK, EMAIL_LIGHT, EMAIL_WORDMARK } from './email-shell.ts';
import { brandRequestEmailBody } from './handler.ts';

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

const html = brandRequestEmailBody({
  requesterName: 'Priya',
  brandName: 'Acme',
  signUpUrl: 'https://app.test/signup',
}).html;

describe('brand-request email: light and dark', () => {
  it('renders the light look', () => expectLight(html));
  it('renders the dark look', () => expectDark(html));
  it('has an ink button, never a #000000 rim', () => {
    expect(html).toContain('class="btn"');
    expect(html).not.toContain('#000000');
  });
});

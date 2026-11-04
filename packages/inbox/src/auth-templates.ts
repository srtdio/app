// The Supabase Auth email templates (supabase/templates/magic-link.html and
// confirm-signup.html) are static files Supabase fills with Go template tags,
// so they cannot import the shell. They are GENERATED from this function and
// committed; email-look.test.ts fails when a file drifts from it. To change
// them, change this file or email-shell.ts and regenerate both files from
// renderAuthCodeTemplate().

import {
  EMAIL_LIGHT,
  EMAIL_SANS,
  emailCard,
  emailDocument,
  emailCodeBox,
  emailRule,
} from './email-shell';

export const AUTH_TEMPLATES = {
  'magic-link': 'supabase/templates/magic-link.html',
  'confirm-signup': 'supabase/templates/confirm-signup.html',
} as const;

export type AuthTemplate = keyof typeof AUTH_TEMPLATES;

const L = EMAIL_LIGHT;

function line(cls: 'fg2' | 'fg3', text: string, top: number): string {
  return `<div class="${cls}" style="padding-top:${top}px;font-family:${EMAIL_SANS};font-size:14px;line-height:22px;color:${L[cls]}">${text}</div>`;
}

/** The whole template, Go tags ({{ .Token }}, {{ .Email }}) left in place. */
export function renderAuthCodeTemplate(_kind: AuthTemplate): string {
  const inner =
    `<div class="fg" style="font-family:${EMAIL_SANS};font-size:20px;font-weight:600;line-height:28px;letter-spacing:-0.01em;color:${L.fg}">Your Sorted code</div>` +
    line('fg2', 'Enter this code in Sorted to sign in.', 8) +
    `<div style="padding-top:20px">${emailCodeBox('{{ .Token }}')}</div>` +
    line('fg2', 'The code expires in 1 hour.', 20) +
    line('fg2', 'Don&rsquo;t share it with anyone.', 0) +
    `<div style="padding-top:24px">${emailRule()}</div>` +
    line('fg3', 'Didn&rsquo;t ask for this? Ignore this email.', 16);
  return (
    emailDocument({
      title: 'Your Sorted code',
      content: `<tr><td>${emailCard(inner)}</td></tr>`,
      footer: `Sent to <span class="fg2" style="color:${L.fg2}">{{ .Email }}</span> &middot; srtd.io`,
    }) + '\n'
  );
}

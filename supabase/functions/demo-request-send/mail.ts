// VERBATIM COPY of supabase/functions/book-call-send/mail.ts, the source of
// truth (edge functions are self-contained; there is no supabase/functions/_shared).
// Keep everything below this header identical to that file; change both together.

// The mail goes to the team inbox (BOOK_CALL_TO_ADDRESS), so it is a plain
// heading + label/value rows card in the shared email shell (email-shell.ts).

import { EMAIL_LIGHT, EMAIL_SANS, emailCard, emailDocument } from './email-shell.ts';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

export interface MailRow {
  label: string;
  value: string;
}

/** A heading and label/value rows as { html, text }. */
export function requestEmailBody(input: { heading: string; rows: MailRow[] }): {
  html: string;
  text: string;
} {
  const text = `${input.heading}\n\n${input.rows.map((row) => `${row.label}: ${row.value}`).join('\n')}\n`;
  const L = EMAIL_LIGHT;
  const rows = input.rows
    .map(
      (row) =>
        `<tr><td class="fg2" style="padding:6px 12px 6px 0;font-family:${EMAIL_SANS};font-size:13px;line-height:20px;color:${L.fg2};width:140px;vertical-align:top;">${escapeHtml(row.label)}</td>` +
        `<td class="fg" style="padding:6px 0;font-family:${EMAIL_SANS};font-size:15px;line-height:20px;color:${L.fg};vertical-align:top;">${escapeHtml(row.value)}</td></tr>`,
    )
    .join('');
  const html = emailDocument({
    title: input.heading,
    content:
      `<tr><td>` +
      emailCard(
        `<h1 class="fg" style="margin:0;font-family:${EMAIL_SANS};font-size:20px;line-height:28px;font-weight:600;color:${L.fg};">${escapeHtml(input.heading)}</h1>` +
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:12px">${rows}</table>`,
      ) +
      `</td></tr>`,
    footer: 'Sent by Sorted to the team inbox.',
  });
  return { html, text };
}

/** Hex sha256 of the joined parts: the Resend Idempotency-Key. */
export async function sha256Hex(parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|')));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

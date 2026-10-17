// VERBATIM COPY of supabase/functions/book-call-send/mail.ts, the source of
// truth (edge functions are self-contained; there is no supabase/functions/_shared).
// Keep everything below this header identical to that file; change both together.

// The mail goes to the team inbox (BOOK_CALL_TO_ADDRESS), so it is a plain
// heading + label/value rows card. Every color is inline, no <style>.

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
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  const rows = input.rows
    .map(
      (row) =>
        `<tr><td style="padding:6px 0;font-family:${font};font-size:13px;color:#8b8799;width:140px;vertical-align:top;">${escapeHtml(row.label)}</td>` +
        `<td style="padding:6px 0;font-family:${font};font-size:15px;color:#1e1b2e;vertical-align:top;">${escapeHtml(row.value)}</td></tr>`,
    )
    .join('');
  const html =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"></head>` +
    `<body style="margin:0;padding:24px;background-color:#f6f5fa;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;border:1px solid #e7e5ef;">` +
    `<tr><td style="padding:24px 28px 8px 28px;"><h1 style="margin:0;font-family:${font};font-size:20px;font-weight:700;color:#1e1b2e;">${escapeHtml(input.heading)}</h1></td></tr>` +
    `<tr><td style="padding:8px 28px 24px 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>` +
    `</table></body></html>`;
  return { html, text };
}

/** Hex sha256 of the joined parts: the Resend Idempotency-Key. */
export async function sha256Hex(parts: string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|')));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

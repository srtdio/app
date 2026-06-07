// Invite email: deterministic Message-ID, subject, body, and the Resend
// transport. The Message-ID is <invite-{member_id}@srtd.io> (standing answer)
// so a re-send threads onto the same email_threads row instead of forking.
// The transport is an injectable interface; the edge function wires the real
// Resend sender, unit tests pass a fake.

export const INVITE_TEMPLATE_KEY = 'member_invite';

export interface InviteEmailMessage {
  to: string;
  from: string;
  subject: string;
  /** RFC 5322 Message-ID, angle-bracketed. */
  messageId: string;
  html: string;
  text: string;
}

export interface EmailSender {
  send(message: InviteEmailMessage): Promise<{ id: string }>;
}

export function inviteMessageId(memberId: string): string {
  return `<invite-${memberId}@srtd.io>`;
}

export function inviteSubject(workspaceName: string): string {
  return `[${workspaceName}] You have been invited.`;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

export interface InviteEmailBodyInput {
  workspaceName: string;
  role: string;
  acceptUrl: string;
}

export function inviteEmailBody(input: InviteEmailBodyInput): { html: string; text: string } {
  const text =
    `You have been invited to join ${input.workspaceName} as ${input.role}. ` +
    `Accept your invite: ${input.acceptUrl}`;
  const html =
    `<p>You have been invited to join <strong>${escapeHtml(input.workspaceName)}</strong> ` +
    `as ${escapeHtml(input.role)}.</p>` +
    `<p><a href="${escapeHtml(input.acceptUrl)}">Accept your invite</a></p>`;
  return { html, text };
}

export interface ResendConfig {
  apiKey: string;
  /** Override for tests; defaults to the public Resend endpoint. */
  endpoint?: string;
}

export function createResendSender(config: ResendConfig): EmailSender {
  const endpoint = config.endpoint ?? 'https://api.resend.com/emails';
  return {
    async send(message: InviteEmailMessage): Promise<{ id: string }> {
      // globalThis.fetch (not the bare global) keeps the ESLint fetch guard
      // satisfied; this package never crosses a trace boundary that needs the
      // src/lib/fetch wrapper.
      const response = await globalThis.fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: message.from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          headers: { 'Message-Id': message.messageId },
        }),
      });
      if (!response.ok) {
        throw new Error(`resend send failed (${response.status}): ${await response.text()}`);
      }
      const data = (await response.json()) as { id?: string };
      if (!data.id) throw new Error('resend response did not include an id');
      return { id: data.id };
    },
  };
}

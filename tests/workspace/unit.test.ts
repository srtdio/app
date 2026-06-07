// Pure unit coverage for the workspace package: the send-window gate, the
// deterministic Message-ID / subject / body, and the Resend transport against a
// stubbed fetch. No database, so this file runs under both the root `pnpm test`
// and the dedicated workspace config.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createResendSender,
  inviteEmailBody,
  inviteMessageId,
  inviteSendSchedule,
  inviteSubject,
  type InviteEmailMessage,
} from '../../packages/workspace/src/index';

describe('inviteSendSchedule (9am-9pm workspace TZ gate)', () => {
  it('sends now inside the window', () => {
    const now = new Date('2026-06-15T12:00:00.000Z');
    const schedule = inviteSendSchedule('UTC', now);
    expect(schedule.sendNow).toBe(true);
    expect(schedule.scheduledFor).toBe(now.toISOString());
  });

  it('treats 9am as the inclusive start of the window', () => {
    expect(inviteSendSchedule('UTC', new Date('2026-06-15T09:00:00.000Z')).sendNow).toBe(true);
  });

  it('queues to the same-day 9am when before the window', () => {
    const schedule = inviteSendSchedule('UTC', new Date('2026-06-15T06:00:00.000Z'));
    expect(schedule.sendNow).toBe(false);
    expect(schedule.scheduledFor).toBe('2026-06-15T09:00:00.000Z');
  });

  it('queues to the next-day 9am at and after 9pm', () => {
    expect(inviteSendSchedule('UTC', new Date('2026-06-15T21:00:00.000Z'))).toEqual({
      sendNow: false,
      scheduledFor: '2026-06-16T09:00:00.000Z',
    });
    expect(inviteSendSchedule('UTC', new Date('2026-06-15T23:30:00.000Z')).scheduledFor).toBe(
      '2026-06-16T09:00:00.000Z',
    );
  });

  it('respects a non-UTC workspace timezone', () => {
    // 02:00Z is 07:30 in Asia/Kolkata (UTC+5:30): before the window.
    const before = inviteSendSchedule('Asia/Kolkata', new Date('2026-06-15T02:00:00.000Z'));
    expect(before.sendNow).toBe(false);
    expect(before.scheduledFor).toBe('2026-06-15T03:30:00.000Z'); // 09:00 IST

    // 07:00Z is 12:30 IST: inside the window.
    expect(inviteSendSchedule('Asia/Kolkata', new Date('2026-06-15T07:00:00.000Z')).sendNow).toBe(
      true,
    );
  });
});

describe('invite email shaping', () => {
  it('builds the deterministic Message-ID', () => {
    expect(inviteMessageId('1111-2222')).toBe('<invite-1111-2222@srtd.io>');
  });

  it('builds the bracketed subject', () => {
    expect(inviteSubject('Acme Co')).toBe('[Acme Co] You have been invited.');
  });

  it('escapes HTML in the body but leaves the text plain', () => {
    const body = inviteEmailBody({
      workspaceName: 'A & B <Studio>',
      role: 'client',
      acceptUrl: 'https://app.srtd.io/invites/x/accept',
    });
    expect(body.html).toContain('A &amp; B &lt;Studio&gt;');
    expect(body.html).not.toContain('<Studio>');
    expect(body.text).toContain('A & B <Studio>');
    expect(body.text).toContain('https://app.srtd.io/invites/x/accept');
  });
});

describe('createResendSender', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const message: InviteEmailMessage = {
    to: 'invitee@example.test',
    from: 'invites@srtd.io',
    subject: '[Acme] You have been invited.',
    messageId: '<invite-abc@srtd.io>',
    html: '<p>hi</p>',
    text: 'hi',
  };

  it('posts to Resend with the Message-Id header and returns the provider id', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ id: 'resend_123' }), { status: 200 }));
    const sender = createResendSender({
      apiKey: 'rk_test',
      endpoint: 'https://resend.test/emails',
    });

    const result = await sender.send(message);

    expect(result).toEqual({ id: 'resend_123' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://resend.test/emails');
    const payload = JSON.parse(String(init?.body)) as { headers: { 'Message-Id': string } };
    expect(payload.headers['Message-Id']).toBe('<invite-abc@srtd.io>');
  });

  it('throws when Resend rejects the send', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 422 }));
    const sender = createResendSender({ apiKey: 'rk_test' });
    await expect(sender.send(message)).rejects.toThrow(/resend send failed \(422\)/);
  });
});

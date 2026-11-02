import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement, type ReactElement } from 'react';
import { dispatchSend, PrivateReplyBar, scheduleOfferedFor } from '@/components/chat/Composer';
import { IconButton } from '@/components/ui/IconButton';
import { getDraft, resetDrafts, setPrivateReplyDraft } from '@/lib/chat/drafts';
import { privateReplyFromDraft, type PrivateReplyDraft } from '@/lib/chat/private-reply';

const QUOTE: PrivateReplyDraft = {
  kind: 'chat',
  sourceId: 'm1',
  authorUserId: 'u-asha',
  authorName: 'Asha Rao',
  excerpt: 'Can you send the deck?',
  whereLabel: 'Launch team',
  link: { kind: 'chat', channelId: 'g1', messageId: 'm1' },
};

describe('PrivateReplyBar (the composer quote strip)', () => {
  it('reads "<Full name> · <where>" over one truncated line, on the accent rule', () => {
    const html = renderToStaticMarkup(
      <PrivateReplyBar quote={QUOTE} preview="Can you send the deck?" onRemove={() => {}} />,
    );
    expect(html).toContain('data-private-reply-bar');
    expect(html).toContain('Asha Rao · Launch team');
    expect(html).toContain('Can you send the deck?');
    expect(html).toContain('truncate');
    expect(html).toContain('bg-accent');
    // The reply bar's X, aria-label only (no new visible text).
    expect(html).toContain('aria-label="Cancel reply"');
  });

  it('its X removes the quote', () => {
    const onRemove = vi.fn();
    const bar = PrivateReplyBar({ quote: QUOTE, preview: 'x', onRemove });
    const box = (bar.props as { children: ReactElement }).children;
    const trailing = (box.props as { trailing: ReactElement }).trailing;
    expect(isValidElement(trailing) && trailing.type).toBe(IconButton);
    (trailing.props as { onClick: () => void }).onClick();
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('removing it clears the quote from the draft and keeps the rest', () => {
    resetDrafts();
    setPrivateReplyDraft('dm-1', QUOTE);
    expect(getDraft('dm-1').privateReply).toEqual(QUOTE);
    setPrivateReplyDraft('dm-1', null);
    expect(getDraft('dm-1').privateReply).toBeNull();
    resetDrafts();
  });
});

describe('Schedule while a quote is attached', () => {
  it('is hidden with a quote, offered without one', () => {
    expect(scheduleOfferedFor({ wired: true, quoteAttached: true })).toBe(false);
    expect(scheduleOfferedFor({ wired: true, quoteAttached: false })).toBe(true);
    expect(scheduleOfferedFor({ wired: false, quoteAttached: false })).toBe(false);
  });
});

describe('dispatchSend with a quote', () => {
  const base = {
    text: 'Sure',
    attachments: [],
    sharedPostIds: [],
    reply: null,
    sharedBriefIds: [],
  };

  it('passes the quote as the sixth argument', () => {
    const onSend = vi.fn();
    const quote = privateReplyFromDraft(QUOTE);
    expect(dispatchSend(onSend, { ...base, privateReply: quote })).toBe(true);
    expect(onSend).toHaveBeenCalledWith('Sure', [], [], null, [], quote);
  });

  it('an ordinary send keeps its five arguments', () => {
    const onSend = vi.fn();
    dispatchSend(onSend, { ...base, privateReply: null });
    expect(onSend).toHaveBeenCalledWith('Sure', [], [], null, []);
    expect(onSend.mock.calls[0]).toHaveLength(5);
  });
});

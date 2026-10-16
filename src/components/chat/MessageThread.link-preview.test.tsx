import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
import { MessageBubble } from '@/components/chat/MessageThread';
import { PresignCache } from '@/lib/asset-presign';
import type { ChatProfile } from '@/lib/chat-reads';
import type { ThreadMessage } from '@/lib/chat/thread';

// Rendered on the server (no Worker URL in the test env), so every card is the
// bare card known at first paint: the markup shows where and how often it goes.

const cache = new PresignCache({
  endpoint: null,
  getAccessToken: () => Promise.resolve(null),
  fetcher: () => Promise.reject(new Error('unused')),
});
const PROFILES: Map<string, ChatProfile> = new Map([
  ['peer-1', { userId: 'peer-1', displayName: 'Alice', avatarUrl: null }],
]);
const AT = '2026-10-01T10:00:00Z';

function bubble(body: string, mine = false): string {
  const message: ThreadMessage = {
    id: 'm1',
    senderUserId: mine ? 'me' : 'peer-1',
    body,
    createdAt: AT,
    time: Date.parse(AT),
    provisionalTime: false,
    mine,
    attachments: [],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
  };
  return renderToStaticMarkup(
    <MemoryRouter>
      <MessageBubble
        message={message}
        profiles={PROFILES}
        cache={cache}
        presignEnabled={false}
        showTicks={false}
        isGroup={false}
        head
        tail
        timeZone="UTC"
        layout="touch"
        onBadgeClick={() => {}}
      />
    </MemoryRouter>,
  );
}

const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe('MessageBubble link card', () => {
  it('only the first external link gets a card, above the text; every link stays tappable text', () => {
    const html = bubble('look https://a.com/x and https://b.com/y');
    expect(count(html, 'data-link-card=""')).toBe(1);
    expect(html.indexOf('data-link-card')).toBeLessThan(html.indexOf('data-msg-body'));
    expect(html).toContain('href="https://a.com/x"');
    expect(count(html, 'data-msg-link=""')).toBe(2);
    expect(html).toContain('a.com');
  });

  it('no card without a link', () => {
    expect(bubble('just words')).not.toContain('data-link-card');
  });

  it('own (accent) bubbles use the translucent on-accent surface', () => {
    const html = bubble('https://a.com/x', true);
    expect(html).toContain('bg-overlay-surface');
    expect(html).toContain('border-overlay-line');
  });

  it('an unsafe first link gets the warning card, also for the sender', () => {
    const html = bubble('pls see http://g00gle-docs-share.top:8080/login', true);
    expect(html).toContain('data-card-type="unsafe"');
    expect(html).toContain('This link may be unsafe');
  });
});

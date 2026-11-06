import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { channelRowParts, DRAFT_PREFIX, rowDraft } from '@/components/chat/ChannelList';
import type { ChannelSummary } from '@/lib/chat-reads';

const channel: ChannelSummary = {
  channelId: 'c1',
  // A group: its Row carries the preview line (a person tile has none).
  channelType: 'group',
  title: 'Ana',
  avatarUrl: null,
  agoraGroupId: null,
  groupId: null,
  peerUserId: 'u2',
  createdAt: '2026-09-01T00:00:00Z',
};

describe('chat list draft preview', () => {
  it('shows a draft only for a chat that is not open', () => {
    expect(rowDraft('half typed', false)).toBe('half typed');
    expect(rowDraft('half typed', true)).toBeNull();
    expect(rowDraft('   ', false)).toBeNull();
  });

  it('reads "Draft: " in the accent at weight 500, then the draft text', () => {
    const html = renderToStaticMarkup(
      channelRowParts({
        channel,
        summary: undefined,
        draft: 'half typed',
        nowMs: 0,
        timeZone: 'UTC',
        selecting: false,
        checked: false,
      }).preview,
    );
    expect(DRAFT_PREFIX).toBe('Draft: ');
    expect(html).toMatch(/<span class="text-accent font-medium">Draft: <\/span>half typed/);
    expect(html).not.toContain('No messages yet');
  });

  it('without a draft the preview is unchanged', () => {
    const html = renderToStaticMarkup(
      channelRowParts({
        channel,
        summary: undefined,
        nowMs: 0,
        timeZone: 'UTC',
        selecting: false,
        checked: false,
      }).preview,
    );
    expect(html).toContain('No messages yet');
    expect(html).not.toContain(DRAFT_PREFIX);
  });

  it('a person tile has no preview line (the time is its meta)', () => {
    const parts = channelRowParts({
      channel: { ...channel, channelType: 'dm' },
      summary: undefined,
      draft: 'half typed',
      nowMs: 0,
      timeZone: 'UTC',
      selecting: false,
      checked: false,
    });
    expect(parts.preview).toBeNull();
  });
});

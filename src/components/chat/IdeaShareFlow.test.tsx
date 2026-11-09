import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
// The Sheet portals to document.body; static markup renders its body in place.
vi.mock('@/components/ui/Sheet', () => ({
  Sheet: (props: { open: boolean; title: string; children: ReactNode; footer?: ReactNode }) =>
    props.open ? (
      <div>
        <h2>{props.title}</h2>
        {props.children}
        {props.footer}
      </div>
    ) : null,
}));
const rpc = vi.hoisted(() => ({
  planShareWithClient: vi.fn(),
  chatPlanShare: vi.fn(),
}));
vi.mock('@srtdio/rpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@srtdio/rpc')>()),
  planShareWithClient: rpc.planShareWithClient,
  chatPlanShare: rpc.chatPlanShare,
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  IDEA_SHOW_TITLE,
  ideaPickChannels,
  ideaShowLine,
  isIdeaNotSharedWithClient,
  openPlanThenShareIdea,
  refusedPath,
  showThenShare,
} from '@/components/chat/IdeaShareFlow';
import {
  PLAN_OPEN_SEND_TITLE,
  PlanOpenSendSheet,
  isPlanNotSharedWithClient,
  openPlanThenShare,
  planOpenSendLine,
} from '@/components/chat/PlanOpenSendSheet';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { ChatMessageRow } from '@/lib/chat/thread';

const row = { id: 'msg1' } as unknown as ChatMessageRow;

function channel(over: Partial<ChannelSummary>): ChannelSummary {
  return {
    channelId: 'c',
    channelType: 'group',
    title: 'Chat',
    avatarUrl: null,
    agoraGroupId: null,
    groupId: null,
    peerUserId: null,
    createdAt: '2026-11-01T00:00:00Z',
    ...over,
  };
}

describe('idea_not_shared_with_client sheet path', () => {
  it('the refusal is recognised and the sheet names the chat and the comment count', () => {
    expect(isIdeaNotSharedWithClient('P0001: idea_not_shared_with_client')).toBe(true);
    expect(isIdeaNotSharedWithClient('idea not available')).toBe(false);
    expect(IDEA_SHOW_TITLE).toBe('Show this idea to approvers?');
    expect(ideaShowLine('Acme', 4)).toBe(
      'This idea is team only and Acme has approvers in it. Showing it lets them see the idea and all 4 comments.',
    );
    expect(ideaShowLine('Acme', 1)).toContain('all 1 comment.');
  });

  it('Send in Team instead lists chats not known to have the client, never notes or the refused chat', () => {
    const list = [
      channel({ channelId: 'notes', channelType: 'notes' }),
      channel({ channelId: 'dm-client', channelType: 'dm', role: 'client' }),
      channel({ channelId: 'dm-team', channelType: 'dm', role: 'agency' }),
      channel({ channelId: 'refused' }),
      channel({ channelId: 'team' }),
    ];
    expect(ideaPickChannels(list, false).map((c) => c.channelId)).toEqual([
      'dm-client',
      'dm-team',
      'refused',
      'team',
    ]);
    expect(ideaPickChannels(list, true, 'refused').map((c) => c.channelId)).toEqual([
      'dm-team',
      'team',
    ]);
  });

  it('Show and send: keeps the flags, shows, then shares again', async () => {
    const calls: string[] = [];
    const setShown = vi.fn(async (flags: { archived: boolean; starred: boolean }) => {
      calls.push(`show ${String(flags.starred)}`);
      return { ok: true as const, data: null };
    });
    const onShown = vi.fn(() => calls.push('shown'));
    const result = await showThenShare({
      readFlags: async () => ({ ok: true, data: { archived: false, starred: true } }),
      setShown,
      share: async () => {
        calls.push('share');
        return { ok: true, data: row };
      },
      onShown,
    });
    expect(result).toEqual({ ok: true, row });
    expect(calls).toEqual(['show true', 'shown', 'share']);
  });

  it('Show and send stops at a failed show and never shares', async () => {
    const share = vi.fn();
    const result = await showThenShare({
      readFlags: async () => ({ ok: true, data: { archived: false, starred: false } }),
      setShown: async () => ({ ok: false, error: { code: 'unknown', message: 'nope' } }),
      share,
      onShown: () => undefined,
    });
    expect(result).toEqual({ ok: false, step: 'show', message: 'nope' });
    expect(share).not.toHaveBeenCalled();
  });
});

describe('plan_not_shared_with_client sheet path', () => {
  it('the sheet copy and buttons', () => {
    expect(isPlanNotSharedWithClient('P0001: plan_not_shared_with_client')).toBe(true);
    expect(PLAN_OPEN_SEND_TITLE).toBe('Open this plan for approvers?');
    expect(planOpenSendLine('Week of 9 Nov', 'Acme')).toBe(
      'Week of 9 Nov is a Draft. Sending it in Acme opens it for approvers: they see every item in it.',
    );
    const html = renderToStaticMarkup(
      <PlanOpenSendSheet
        ask={{ planId: 'p1', planTitle: 'Week of 9 Nov', channelId: 'c1', chatName: 'Acme' }}
        onClose={() => undefined}
        onOpenAndSend={() => undefined}
      />,
    );
    expect(html).toContain('Open this plan for approvers?');
    expect(html).toContain('Cancel');
    expect(html).toContain('Open and send');
    expect(html.indexOf('Cancel')).toBeLessThan(html.indexOf('Open and send'));
    expect(
      renderToStaticMarkup(
        <PlanOpenSendSheet ask={null} onClose={() => undefined} onOpenAndSend={() => undefined} />,
      ),
    ).toBe('');
  });

  it('Open and send: plan_share_with_client, then chat_plan_share with the same message id', async () => {
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    rpc.planShareWithClient.mockResolvedValueOnce({ ok: true, data: null });
    rpc.chatPlanShare.mockResolvedValueOnce({ ok: true, data: row });
    const res = await openPlanThenShare({ planId: 'p1', channelId: 'c1', messageId: 'msg1' });
    expect(res).toEqual({ ok: true, data: row });
    expect(rpc.planShareWithClient).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ p_plan_id: 'p1' }),
    );
    expect(rpc.chatPlanShare).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ p_id: 'msg1', p_channel_id: 'c1', p_plan_id: 'p1' }),
    );
    vi.unstubAllGlobals();
  });

  it('a failed open sends nothing', async () => {
    rpc.chatPlanShare.mockClear();
    rpc.planShareWithClient.mockResolvedValueOnce({
      ok: false,
      error: { code: 'unknown', message: 'forbidden' },
    });
    const res = await openPlanThenShare({ planId: 'p1', channelId: 'c1', messageId: 'msg1' });
    expect(res.ok).toBe(false);
    expect(rpc.chatPlanShare).not.toHaveBeenCalled();
  });
});

describe('a refused idea inside a Draft plan takes the plan path', () => {
  it('a planned idea opens its plan; a bank idea asks to show it', () => {
    expect(refusedPath({ plan: { id: 'p1', title: 'Week of 2 Nov' } })).toBe('open-plan');
    expect(refusedPath({ plan: null })).toBe('show-idea');
    expect(refusedPath({})).toBe('show-idea');
  });

  it('Open and send: plan_share_with_client, then the share again; never bank_idea_set', async () => {
    const calls: string[] = [];
    const result = await openPlanThenShareIdea({
      openPlan: async () => {
        calls.push('open');
        return { ok: true, data: null };
      },
      share: async () => {
        calls.push('share');
        return { ok: true, data: row };
      },
    });
    expect(result).toEqual({ ok: true, row });
    expect(calls).toEqual(['open', 'share']);
  });

  it('a failed open sends nothing and names the step', async () => {
    const share = vi.fn();
    const result = await openPlanThenShareIdea({
      openPlan: async () => ({ ok: false, error: { code: 'unknown', message: 'forbidden_role' } }),
      share,
    });
    expect(result).toEqual({ ok: false, step: 'open', message: 'forbidden_role' });
    expect(share).not.toHaveBeenCalled();
  });
});

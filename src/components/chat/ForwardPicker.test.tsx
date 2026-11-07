import { describe, expect, it, vi } from 'vitest';

// The Sheet portals to document.body; static markup renders its header verb and body in place.
vi.mock('@/components/ui/Sheet', () => ({
  Sheet: (props: { open: boolean; headerAction?: ReactNode; children: ReactNode }) =>
    props.open ? (
      <>
        {props.headerAction}
        {props.children}
      </>
    ) : null,
}));
vi.mock('@/components/chat/ChatStoreProvider', () => ({
  useChatStore: () => ({ state: {} }),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ show: () => undefined }) }));
vi.mock('@/lib/chat/use-history-step', () => ({ useHistoryStep: () => undefined }));

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ForwardPicker,
  SEARCH_CHATS_LABEL,
  forwardTargetsFromHits,
} from '@/components/chat/ForwardPicker';
import { PalettePickProvider } from '@/components/shell/CommandPalette';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { WorkspaceHit } from '@/lib/search/workspace-search';

function picker(): ReactNode {
  return (
    <ForwardPicker
      open
      onClose={() => undefined}
      channels={[]}
      onSend={async () => ({ ok: true })}
      onSent={() => undefined}
    />
  );
}

function channel(id: string, type: ChannelSummary['channelType'], peer: string | null) {
  return {
    channelId: id,
    channelType: type,
    title: id,
    avatarUrl: null,
    agoraGroupId: null,
    groupId: null,
    peerUserId: peer,
    createdAt: '2026-10-01T00:00:00Z',
  } satisfies ChannelSummary;
}

function hit(kind: WorkspaceHit['kind'], id: string, channelId: string | null = null): WorkspaceHit {
  return {
    kind,
    id,
    parentId: null,
    channelId,
    entityType: '',
    number: null,
    title: id,
    snippet: '',
    actorUserId: null,
    actorIsMember: false,
    createdAt: '2026-10-01T00:00:00Z',
  };
}

describe('ForwardPicker zero state', () => {
  it('no chats reads "Chats show up here."', () => {
    const html = renderToStaticMarkup(<>{picker()}</>);
    expect(html).toContain('Chats show up here.');
    expect(html).not.toContain('No matches');
    expect(html).not.toContain('Try another word');
  });
});

describe('ForwardPicker search: the palette in pick mode', () => {
  it('no search field of its own', () => {
    const html = renderToStaticMarkup(<>{picker()}</>);
    expect(html).not.toContain('type="search"');
    expect(html).not.toContain('placeholder="Search chats"');
  });

  it('a search button in the sheet header inside the shell; none outside it', () => {
    const inside = renderToStaticMarkup(
      <PalettePickProvider openPick={() => undefined}>{picker()}</PalettePickProvider>,
    );
    expect(inside).toContain(`aria-label="${SEARCH_CHATS_LABEL}"`);
    expect(inside).toContain('data-palette-pick-open');
    expect(renderToStaticMarkup(<>{picker()}</>)).not.toContain('data-palette-pick-open');
  });

  it('asks for people and groups, many at once, "Send N"', () => {
    const src = readFileSync(fileURLToPath(new URL('./ForwardPicker.tsx', import.meta.url)), 'utf8');
    expect(src).toContain("pickKinds: ['person', 'chat_group']");
    expect(src).toContain('multi: true');
    expect(src).toContain("verb: 'Send'");
  });

  it('maps picks to chats: a person their DM, a group its chat; no DM yet is left out', () => {
    const dm = channel('dm1', 'dm', 'u1');
    const group = channel('group__w__g', 'group', null);
    const targets = forwardTargetsFromHits(
      [
        hit('chat_group', 'g', 'group__w__g'),
        hit('person', 'u1'),
        hit('person', 'u9'),
        hit('person', 'u1'),
      ],
      [dm, group],
    );
    expect(targets.map((c) => c.channelId)).toEqual(['group__w__g', 'dm1']);
  });
});

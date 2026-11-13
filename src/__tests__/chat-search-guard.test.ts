// Search inside a chat (13 Nov 2026, WhatsApp's way): the bar's key, the field
// in the bar's place, the step bar in the composer's place, the chat's own jump,
// the current hit ringed by data-search-current, file names in one chat.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(__dirname, '..', '..', path), 'utf8');

describe('search inside a chat', () => {
  it('the chat bar carries the key; searching swaps the bar and the composer', () => {
    const thread = read('src/components/chat/MessageThread.tsx');
    expect(thread).toContain('<ChatSearchKey onOpen={chatSearch.start} />');
    expect(thread).toContain('<ChatSearchField chatName={props.title} search={chatSearch} />');
    expect(thread).toContain('<ChatSearchSteps search={chatSearch} />');
    expect(thread).toContain('<SearchCurrentContext.Provider');
  });

  it('hits come from chat_message_search scoped to the chat, walked with the quiet jump', () => {
    const search = read('src/components/chat/ChatSearch.tsx');
    expect(search).toContain('searchMessages({ client: supabase, workspaceId, channelId');
    expect(search).toContain("if (event.key === 'Escape')");
    expect(read('src/components/chat/MessageThread.tsx')).toContain('quiet: true })),');
  });

  it('the current hit rings its words; file names match inside one chat', () => {
    expect(read('src/index.css')).toContain('[data-search-current] mark[data-search-mark]');
    expect(read('src/components/chat/MessageBubble.tsx')).toContain('data-search-current=');
    expect(read('supabase/migrations/20261113090000_chat_message_search_file_names.sql')).toContain(
      'p_channel_id is not null and exists',
    );
  });
});

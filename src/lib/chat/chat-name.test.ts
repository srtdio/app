import { describe, expect, it } from 'vitest';
import { chatDisplayName } from '@/lib/chat/chat-name';

describe('chatDisplayName', () => {
  it('names a direct message after the other person', () => {
    expect(chatDisplayName({ channelType: 'dm', title: 'Priya Shah' })).toBe('Priya Shah');
  });

  it('names a group after the group', () => {
    expect(chatDisplayName({ channelType: 'group', title: 'Campaign team' })).toBe('Campaign team');
  });

  it('names the notes chat "Personal notes" whatever its row says', () => {
    expect(chatDisplayName({ channelType: 'notes', title: 'anything' })).toBe('Personal notes');
  });

  it('never returns a blank name', () => {
    expect(chatDisplayName({ channelType: 'group', title: '  ' })).toBe('Group');
    expect(chatDisplayName({ channelType: 'dm', title: '' })).toBe('Direct message');
  });
});

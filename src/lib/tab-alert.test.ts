import { describe, expect, it } from 'vitest';
import { ALERT_DOT, chatAlertText, dotColor, titleFor, type TabAlert } from '@/lib/tab-alert';

const comment: TabAlert = { kind: 'activity', text: 'Chitra commented on Diwali reel' };
const chat: TabAlert = { kind: 'chat', text: 'Chat · Aditya sent a message' };

describe('titleFor', () => {
  it('alternates the count with each event in turn', () => {
    const q = [comment, chat];
    expect(titleFor('Sorted', q, 0)).toBe('(2) Sorted');
    expect(titleFor('Sorted', q, 1)).toBe(comment.text);
    expect(titleFor('Sorted', q, 2)).toBe('(2) Sorted');
    expect(titleFor('Sorted', q, 3)).toBe(chat.text);
    expect(titleFor('Sorted', q, 5)).toBe(comment.text);
  });

  it('replaces an existing unread prefix rather than stacking one', () => {
    expect(titleFor('(4) Sorted', [comment], 0)).toBe('(1) Sorted');
  });

  it('is the base title when nothing is pending', () => {
    expect(titleFor('Sorted', [], 1)).toBe('Sorted');
  });
});

describe('dotColor', () => {
  it('takes the newest event: amber for Activity, blue for chat, none when empty', () => {
    expect(dotColor([chat, comment])).toBe(ALERT_DOT.activity);
    expect(dotColor([comment, chat])).toBe(ALERT_DOT.chat);
    expect(dotColor([])).toBeNull();
  });
});

describe('chatAlertText', () => {
  it('names who wrote or the group, never the message', () => {
    expect(chatAlertText('dm', 'Aditya')).toBe('Chat · Aditya sent a message');
    expect(chatAlertText('group', 'GBL team')).toBe('Chat · New message in GBL team');
  });
});

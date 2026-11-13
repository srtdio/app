// Mentions in Catch up (13 Nov 2026, Slack way): every @name is bold, a row
// that mentions me is tinted with the left bar, and a reply sent from Catch up
// shows "@name" straight away, never the stored @[uuid] token.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageRow, mentionRuns, rowMentionsMe } from '@/components/catch-up/CatchUpRows';
import { MENTION_ME_PEER } from '@/components/chat/MessageBubble';
import { catchUpText, type CatchUpMessageRow } from '@/lib/catch-up/body';
import { rememberMentionNames } from '@/lib/chat/mentions';

const WS = '0190f1d0-0000-7000-8000-00000000c0de';
const MANISHA = '8b1338e3-35b1-410e-8107-da8249b44560';
const ME = '0190f1d0-0000-7000-8000-00000000a11e';

rememberMentionNames(WS, [
  { userId: MANISHA, displayName: 'Manisha Thakur', username: 'thakur.manisha' },
  { userId: ME, displayName: 'Shubham Gune', username: 'shubham' },
]);

function row(text: string, mentions: string[]): CatchUpMessageRow {
  return {
    kind: 'message',
    id: 'r1',
    author: { id: MANISHA, name: 'Manisha Thakur', avatarUrl: null },
    createdAt: '2026-11-13T09:42:00.000Z',
    text,
    mentions,
    replyCount: 0,
  };
}

describe('catch-up mentions', () => {
  it('catchUpText resolves a token to "@name" and lists the label (no raw token)', () => {
    const out = catchUpText(WS, `@[${MANISHA}] after this it will be good to go?`);
    expect(out.text).toBe('@thakur.manisha after this it will be good to go?');
    expect(out.text).not.toContain('@[');
    expect(out.mentions).toEqual(['@thakur.manisha']);
  });

  it('mentionRuns splits each mention as a whole word and marks mine', () => {
    const runs = mentionRuns(
      '@thakur.manisha and @shubham, mail a@shubham.in',
      ['@thakur.manisha'],
      'shubham',
    );
    expect(runs.filter((r) => r.mention).map((r) => [r.text, r.self])).toEqual([
      ['@thakur.manisha', false],
      ['@shubham', true],
    ]);
    expect(runs.map((r) => r.text).join('')).toBe(
      '@thakur.manisha and @shubham, mail a@shubham.in',
    );
  });

  it('rowMentionsMe is true only when my label is among the row mentions', () => {
    expect(rowMentionsMe(['@shubham'], 'shubham')).toBe(true);
    expect(rowMentionsMe(['@thakur.manisha'], 'shubham')).toBe(false);
    expect(rowMentionsMe(undefined, 'shubham')).toBe(false);
  });

  it('a row draws every mention bold, mine in ink, and tints itself when it mentions me', () => {
    const html = renderToStaticMarkup(
      <ul>
        <MessageRow
          row={row('@shubham please check with @thakur.manisha', ['@shubham', '@thakur.manisha'])}
          selfName="shubham"
          timeZone="Asia/Kolkata"
          onOpenThread={null}
        />
      </ul>,
    );
    expect(html).toContain('data-mentions-me=""');
    expect(html).toContain('data-mention-me-tint=""');
    expect(html).toMatch(
      /data-catch-up-mention=""[^>]*class="[^"]*font-semibold[^"]*text-accent-hover[^"]*">@thakur\.manisha/,
    );
    expect(html).toContain(MENTION_ME_PEER);
    expect(html).not.toContain('rounded-sm');
  });

  it('a row that only mentions someone else is not tinted', () => {
    const html = renderToStaticMarkup(
      <ul>
        <MessageRow
          row={row('@thakur.manisha given two more options', ['@thakur.manisha'])}
          selfName="shubham"
          timeZone="Asia/Kolkata"
          onOpenThread={null}
        />
      </ul>,
    );
    expect(html).not.toContain('data-mention-me-tint');
    expect(html).toContain('data-catch-up-mention=""');
  });
});

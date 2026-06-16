import { describe, expect, it } from 'vitest';
import {
  buildCatchupUrls,
  countCells,
  isInSendWindow,
  renderCatchupEmail,
  shouldShowCounts,
  summarizeCatchup,
  type CatchupData,
  type CatchupRow,
} from './catchup';

// Catch-up CORE is pure: no DB, no network, no Worker. These tests pin the
// deterministic summary phrasing, the adaptive-counts thresholds, the local
// send-window boundaries (incl. a non-UTC zone), the deep-link URL shapes, and
// the light/dark email render. Boundaries, not middles.

const WS = '00000000-0000-0000-0000-000000000001';
const USER = '00000000-0000-0000-0000-000000000002';

function row(over: Partial<CatchupRow>): CatchupRow {
  return {
    who: 'Asha',
    verb: 'updated',
    target: 'Spring launch',
    time: '2:10pm',
    url: 'https://app.test/x?w=1',
    ...over,
  };
}

function data(over: Partial<CatchupData>): CatchupData {
  return {
    workspaceId: WS,
    workspaceName: 'Acme',
    recipientUserId: USER,
    sinceLabel: '2:00pm',
    stages: [],
    comments: [],
    briefs: [],
    assets: [],
    chats: [],
    ...over,
  };
}

describe('summarizeCatchup', () => {
  it('names a single update specifically', () => {
    const out = summarizeCatchup(
      data({
        stages: [
          row({ who: 'Asha', verb: 'approved', target: 'Spring launch', stage: 'approved' }),
        ],
      }),
    );
    expect(out).toBe('Asha approved Spring launch.');
  });

  it('uses brief phrasing for a single brief', () => {
    const out = summarizeCatchup(
      data({ briefs: [row({ who: 'Bo', verb: 'opened', target: 'Q3 push' })] }),
    );
    expect(out).toBe('Bo opened a brief: Q3 push.');
  });

  it('attributes the multi-item gist to the dominant actor', () => {
    const out = summarizeCatchup(
      data({
        stages: [
          row({ who: 'Asha', verb: 'approved', target: 'A', stage: 'approved' }),
          row({ who: 'Asha', verb: 'rejected', target: 'B', stage: 'rejected' }),
        ],
        briefs: [row({ who: 'Asha', verb: 'opened', target: 'C' })],
        comments: [row({ who: 'Asha', verb: 'commented on', target: 'D' })],
      }),
    );
    expect(out).toBe(
      'Asha approved one post and rejected another, opened a brief and left one comment.',
    );
  });

  it('appends the chat sentence when there are unread chats', () => {
    const out = summarizeCatchup(
      data({
        stages: [row({ who: 'Asha', verb: 'approved', target: 'A', stage: 'approved' })],
        chats: [{ who: 'Bo', count: 3, url: 'https://app.test/chat' }],
      }),
    );
    expect(out).toBe('Asha approved A. You have three unread chat messages.');
  });

  it('falls back when no clean lead can form', () => {
    const out = summarizeCatchup(data({ assets: [row({}), row({}), row({})] }));
    expect(out).toBe('Three updates while you were away.');
  });

  it('ignores actor-less rows when choosing the dominant actor', () => {
    const out = summarizeCatchup(
      data({
        comments: [row({ who: 'Bo', verb: 'commented on', target: 'A' })],
        // Actor-less stage row: must not steal attribution from Bo.
        stages: [{ verb: '', target: 'B', time: '2pm', url: 'u', stage: 'approved' }],
      }),
    );
    expect(out).toBe('Bo left one comment.');
  });
});

describe('shouldShowCounts / countCells', () => {
  it('is false at two distinct sections, true at three', () => {
    const two = data({ stages: [row({})], comments: [row({})] });
    expect(shouldShowCounts(two)).toBe(false);
    const three = data({ stages: [row({})], comments: [row({})], briefs: [row({})] });
    expect(shouldShowCounts(three)).toBe(true);
  });

  it('orders cells Stage, Comments, Brief, Chat, Asset and caps at four', () => {
    const cells = countCells(
      data({
        stages: [row({})],
        comments: [row({})],
        briefs: [row({})],
        assets: [row({})],
        chats: [{ who: 'Bo', count: 5, url: 'u' }],
      }),
    );
    expect(cells.map((c) => c.label)).toEqual(['Stage', 'Comments', 'Brief', 'Chat']);
    expect(cells).toHaveLength(4);
    expect(cells[3]).toEqual({ label: 'Chat', count: 5 });
  });
});

describe('isInSendWindow', () => {
  // 2026-06-15 is a Monday, 2026-06-13 a Saturday. Times chosen in UTC.
  it('is true on a weekday inside 10-18', () => {
    expect(isInSendWindow('UTC', new Date('2026-06-15T12:00:00Z'))).toBe(true);
  });

  it('is false on the weekend', () => {
    expect(isInSendWindow('UTC', new Date('2026-06-13T12:00:00Z'))).toBe(false);
  });

  it('handles the hour boundaries', () => {
    expect(isInSendWindow('UTC', new Date('2026-06-15T09:59:00Z'))).toBe(false);
    expect(isInSendWindow('UTC', new Date('2026-06-15T10:00:00Z'))).toBe(true);
    expect(isInSendWindow('UTC', new Date('2026-06-15T17:59:00Z'))).toBe(true);
    expect(isInSendWindow('UTC', new Date('2026-06-15T18:00:00Z'))).toBe(false);
  });

  it('resolves the local hour in a non-UTC timezone', () => {
    // 04:45Z + 5:30 = 10:15 IST on Monday -> inside the window.
    expect(isInSendWindow('Asia/Kolkata', new Date('2026-06-15T04:45:00Z'))).toBe(true);
    // 04:15Z + 5:30 = 09:45 IST -> before the window.
    expect(isInSendWindow('Asia/Kolkata', new Date('2026-06-15T04:15:00Z'))).toBe(false);
  });
});

describe('buildCatchupUrls', () => {
  const u = buildCatchupUrls('https://app.test', 'ws1');
  it('emits the exact deep-link shapes', () => {
    expect(u.post('p1')).toBe('https://app.test/posts/p1?w=ws1');
    expect(u.brief('b1')).toBe('https://app.test/briefs/b1?w=ws1');
    expect(u.comment('post', 'p1', 'c1')).toBe('https://app.test/posts/p1?w=ws1&comment=c1');
    expect(u.comment('brief', 'b1', 'c2')).toBe('https://app.test/briefs/b1?w=ws1&comment=c2');
    expect(u.asset('a1')).toBe('https://app.test/assets?w=ws1&asset=a1');
    expect(u.chat('ch1')).toBe('https://app.test/chat?w=ws1&channel=ch1');
    expect(u.activity()).toBe('https://app.test/activity?w=ws1');
  });
});

describe('renderCatchupEmail', () => {
  const full = data({
    workspaceName: 'Acme',
    stages: [
      row({
        who: 'Asha',
        verb: 'approved',
        target: 'Spring',
        stage: 'approved',
        url: 'https://app.test/posts/p1?w=ws1',
      }),
    ],
    comments: [
      row({
        who: 'Bo',
        verb: 'commented on',
        target: 'Summer',
        url: 'https://app.test/posts/p2?w=ws1&comment=c1',
      }),
    ],
    briefs: [
      row({ who: 'Cy', verb: 'opened', target: 'Q3', url: 'https://app.test/briefs/b1?w=ws1' }),
    ],
    chats: [{ who: 'Dee', count: 2, url: 'https://app.test/chat?w=ws1&channel=ch1' }],
  });

  it('builds the exact subject', () => {
    expect(renderCatchupEmail(full).subject).toBe('[Acme] Your catch-up');
  });

  it('builds an unthreaded message id unique per slot', () => {
    expect(renderCatchupEmail(full).messageId('2026-06-15T10:00:00Z')).toBe(
      `<catchup-${USER}-2026-06-15T10:00:00Z@srtd.io>`,
    );
  });

  it('has light/dark parity: a light inline hex and a dark media block', () => {
    const { html } = renderCatchupEmail(full);
    expect(html).toContain('#5e6ad2');
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain('[data-ogsc]');
  });

  it('renders every row.url as an href', () => {
    const { html } = renderCatchupEmail(full);
    for (const url of [
      'https://app.test/posts/p1?w=ws1',
      'https://app.test/posts/p2?w=ws1&comment=c1',
      'https://app.test/briefs/b1?w=ws1',
      'https://app.test/chat?w=ws1&channel=ch1',
    ]) {
      expect(html).toContain(`href="${url}"`);
    }
  });

  it('shows the counts strip only when three or more sections', () => {
    expect(renderCatchupEmail(full).html).toContain('>Stage<');
    const sparse = data({ stages: [row({})], comments: [row({})] });
    expect(renderCatchupEmail(sparse).html).not.toContain('>Stage<');
  });

  it('renders an actor-less stage row without an avatar but with the stage word', () => {
    const { html, text } = renderCatchupEmail(
      data({
        stages: [
          { verb: '', target: 'Spring', time: '2pm', url: 'https://app.test/posts/p1?w=ws1', stage: 'approved' },
        ],
      }),
    );
    // No actor -> no avatar cell anywhere, but the coloured stage word remains.
    expect(html).not.toContain('class="avatar"');
    expect(html).toContain('stage-approved');
    expect(html).toContain('Spring');
    expect(text).toContain('Spring approved - https://app.test/posts/p1?w=ws1');
  });

  it('keeps the avatar for actor-bearing rows', () => {
    const { html } = renderCatchupEmail(
      data({ comments: [row({ who: 'Bo', verb: 'commented on', target: 'Summer' })] }),
    );
    expect(html).toContain('class="avatar"');
    expect(html).toContain('Bo commented on Summer');
  });

  it('emits a non-empty text alternative containing every url', () => {
    const { text } = renderCatchupEmail(full);
    expect(text.length).toBeGreaterThan(0);
    for (const url of [
      'https://app.test/posts/p1?w=ws1',
      'https://app.test/posts/p2?w=ws1&comment=c1',
      'https://app.test/briefs/b1?w=ws1',
      'https://app.test/chat?w=ws1&channel=ch1',
    ]) {
      expect(text).toContain(url);
    }
  });
});

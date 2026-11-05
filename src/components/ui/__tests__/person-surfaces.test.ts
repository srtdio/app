// Every surface that shows a person's photo, name or @mention opens the one
// person card (ui/PersonTrigger). A static guard: each wired file must keep
// importing the trigger (or its openPersonCardFrom), so a refactor that drops it
// fails here instead of silently losing the card.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SURFACES: readonly { file: string; what: string }[] = [
  { file: 'chat/MessageThread.tsx', what: 'group sender photo + name, bubble @mentions' },
  { file: 'chat/ChatConnected.tsx', what: 'bubble @mention tap opens the card' },
  { file: 'chat/GroupInfoSheet.tsx', what: 'group members photo + name' },
  { file: 'chat/ReadingLayer.tsx', what: 'read by / reactions rows' },
  { file: 'chat/StarredList.tsx', what: 'starred row sender photo + name' },
  { file: 'chat/PlanItemThread.tsx', what: 'plan comment author + mentions' },
  { file: 'comments/Comments.tsx', what: 'comment author photo + name, @mentions' },
  { file: 'pages/activity/ActivityCard.tsx', what: 'actor photo + entry author' },
  { file: 'pages/activity/AvatarStack.tsx', what: 'bucket avatar stack' },
  { file: 'pages/settings/MembersList.tsx', what: 'member row photo + name' },
  { file: 'pages/PostDetailPage.tsx', what: 'owner photo + name' },
  { file: 'pages/pcs/PostDetailsSheet.tsx', what: 'owner photo' },
  { file: 'pages/BriefDetailPage.tsx', what: 'Raised by name' },
];

function source(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');
}

describe('person surfaces open the shared person card', () => {
  for (const { file, what } of SURFACES) {
    it(`${file} (${what}) imports PersonTrigger`, () => {
      expect(source(file)).toMatch(
        /import \{[^}]*\b(PersonTrigger|openPersonCardFrom)\b[^}]*\} from '@\/components\/ui\/PersonTrigger'/,
      );
    });
  }

  it('the Activity page hands the stack its people', () => {
    expect(source('pages/NotificationsPage.tsx')).toContain('people={bucketActors(entries)}');
  });

  it('a chat @mention tap no longer opens a DM directly: photo in a DM, card elsewhere', () => {
    const chat = source('chat/ChatConnected.tsx');
    expect(chat).toContain(
      "onOpen: selected.channelType === 'dm' ? openMentionPhoto : openMentionCard",
    );
    expect(chat).toMatch(/export function openMentionPhoto\(/);
    expect(chat).not.toMatch(/void openMentionDm\(/);
  });
});

describe('photo-only surfaces (inside a DM)', () => {
  it('the chat list People tile photo opens the chat, not the photo viewer', () => {
    const list = source('chat/ChannelList.tsx');
    expect(list).not.toMatch(/from '@\/components\/ui\/PersonTrigger'/);
    expect(list).not.toContain('PersonTrigger');
    expect(list).not.toContain('view="photo"');
  });

  it('the DM header photo opens the photo viewer', () => {
    const thread = source('chat/MessageThread.tsx');
    const start = thread.indexOf('export function ThreadHeaderIdentity(');
    expect(start).toBeGreaterThan(-1);
    const end = thread.indexOf('\n}\n', start);
    expect(thread.slice(start, end)).toContain('view="photo"');
  });

  it('Reply privately opens the card in place (no DM navigation)', () => {
    expect(source('chat/ChatConnected.tsx')).toContain('openReplyPrivatelyCard(');
    const button = source('comments/ReplyPrivatelyButton.tsx');
    expect(button).not.toContain('useOpenPersonDm');
    expect(button).not.toContain('setPrivateReplyDraft');
  });

  it('no file outside ui/ renders PhotoViewer directly', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const rel = relative(root, full).split(sep).join('/');
          if (rel.startsWith('ui/')) continue;
          if (/<PhotoViewer\b/.test(readFileSync(full, 'utf8'))) offenders.push(rel);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

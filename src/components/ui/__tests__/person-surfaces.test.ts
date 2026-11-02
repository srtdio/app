// Every surface that shows a person's photo, name or @mention opens the one
// person card (ui/PersonTrigger). A static guard: each wired file must keep
// importing the trigger (or its openPersonCardFrom), so a refactor that drops it
// fails here instead of silently losing the card.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SURFACES: readonly { file: string; what: string }[] = [
  { file: 'chat/MessageThread.tsx', what: 'group sender photo + name, bubble @mentions' },
  { file: 'chat/ChatConnected.tsx', what: 'bubble @mention tap opens the card' },
  { file: 'chat/ChannelList.tsx', what: 'People tile photo' },
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

  it('a chat @mention tap no longer opens a DM directly', () => {
    const chat = source('chat/ChatConnected.tsx');
    expect(chat).toContain('onOpen: openMentionCard');
    expect(chat).not.toMatch(/void openMentionDm\(/);
  });
});

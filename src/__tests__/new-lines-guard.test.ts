// New lines on comments (13 Nov 2026): every comment surface draws chat's
// UnreadDivider from newLinePlaces, lands on the first line, and the client
// reads the marks from inbox_unread_comment_marks (never a read on open).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(p, 'utf8');

describe('New lines on comments', () => {
  it.each(['src/components/comments/Comments.tsx', 'src/components/chat/PlanItemThread.tsx'])(
    "%s draws chat's line from newLinePlaces and lands on it",
    (file) => {
      const src = read(file);
      expect(src).toContain('newLinePlaces(');
      expect(src).toContain('<UnreadDivider');
      expect(src).toContain('useEntityNewMarks(');
      expect(src).toContain('useLandOnNewLine(');
    },
  );

  it('the line keeps one part and both words', () => {
    const src = read('src/components/chat/ReadingLayer.tsx');
    expect(src).toContain("label?: 'New' | 'New reply'");
    expect(src).toContain('data-new-line=""');
  });

  it('Plan and Bank comments pass their item for the marks', () => {
    const src = read('src/components/chat/PlanItemScreen.tsx');
    expect(src).toContain('unreadItemId={item.id}');
    expect(src).toContain('unreadItemId={props.itemId}');
  });

  it('marks come from the shell read, and briefs are marked read on open', () => {
    expect(read('src/lib/inbox/unread-entities.ts')).toContain(
      "client.rpc('inbox_unread_comment_marks', args)",
    );
    expect(read('src/components/pages/BriefDetailPage.tsx')).toContain(
      "markEntityReadOnOpen('brief', briefId)",
    );
  });
});

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guards (11 Nov 2026, CLAUDE.md "Comments"): post and brief comments are a
// chat with threads, drawn by chat's own parts. No comment-only composer,
// row, menu, replies row or thread frame; no checkpoints, ticks or photo pins
// on the post or brief screens.

const SRC = fileURLToPath(new URL('../', import.meta.url));
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

function files(dir: string): string[] {
  return readdirSync(join(SRC, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(SRC, path)).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path.split(sep).join('/')] : [];
  });
}

/** Source with comments removed (so prose may still say what was removed). */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** The screens the comments live on. */
const SCREENS = [
  'components/comments/Comments.tsx',
  'components/pages/PostDetailPage.tsx',
  'components/pages/BriefDetailPage.tsx',
  ...files('components/pages/pcs'),
  'components/preview/PlatformPreviewPanel.tsx',
];

/** Comment-only parts that predate this change and serve other surfaces (catch up, concept sheet, post sheet). */
const LEGACY_OUTSIDE_SCREENS = new Set([
  'components/comments/CommentComposer.tsx',
  'components/comments/MentionInput.tsx',
]);

const CHAT_PART =
  /\bfunction\s+(\w*(Composer|MessageRow|MessageBubble|ActionMenu|RepliesRow|ThreadView|ThreadFrame|ThreadRootHead)\w*)\s*\(/;

describe('Guard 1: comments use chat parts, never their own', () => {
  it('no comments file or comment screen defines a composer, row, menu, replies row or thread frame', () => {
    const owners = [...files('components/comments'), ...SCREENS]
      .filter((rel) => !LEGACY_OUTSIDE_SCREENS.has(rel))
      .filter((rel) => CHAT_PART.test(code(read(rel))))
      .map((rel) => `${rel}: ${CHAT_PART.exec(code(read(rel)))?.[1] ?? ''}`);
    expect(owners).toEqual([]);
  });

  it('the comment screens import those parts from src/components/chat only', () => {
    const bad = SCREENS.flatMap((rel) =>
      [
        ...code(read(rel)).matchAll(
          /import\s+[^;]*?\b(\w*(Composer|ActionMenu|RepliesRow|ThreadView\w*|ThreadCommentRow)\w*)\b[^;]*?from\s+'([^']+)'/g,
        ),
      ]
        .filter(
          (m) =>
            !(m[3] ?? '').startsWith('@/components/chat/') &&
            !(m[3] ?? '').startsWith('@/components/ui/'),
        )
        .map((m) => `${rel}: ${m[1] ?? ''} from ${m[3] ?? ''}`),
    );
    expect(bad).toEqual([]);
  });

  it('Comments renders chat Composer, ThreadCommentRow, MessageActionMenu, RepliesRow and ThreadViewFrame', () => {
    const src = read('components/comments/Comments.tsx');
    for (const part of [
      "from '@/components/chat/Composer'",
      "from '@/components/chat/ThreadCommentRow'",
      "from '@/components/chat/MessageActionMenu'",
      "from '@/components/chat/ThreadRail'",
      "from '@/components/chat/ThreadView'",
      '<Composer',
      '<ThreadCommentRow',
      '<MessageActionMenu',
      '<RepliesRow',
      '<RepliesSeparatorRow',
      '<ThreadViewFrame',
      '<ThreadViewFill',
    ]) {
      expect(src, part).toContain(part);
    }
  });

  it('plan threads and post / brief comments share the one row (a chat change reaches both)', () => {
    expect(read('components/chat/PlanItemThread.tsx')).toContain('<ThreadCommentRow');
    expect(read('components/chat/ThreadCommentRow.tsx')).toContain('<MessageBubble');
    expect(read('components/chat/ThreadCommentRow.tsx')).toContain('createSwipeReplyController(');
  });
});

describe('Guard 3: no checkpoints, ticks or pins on the post or brief screens', () => {
  const visible =
    /(['"`>])[^'"`<{}]*\b(checkpoints?|Add pin|On photo|open checkpoints?|Send anyway)\b/i;
  it('no visible "checkpoint", pin or send-anyway words', () => {
    const hits = SCREENS.filter((rel) => visible.test(code(read(rel)))).map(
      (rel) => `${rel}: ${visible.exec(code(read(rel)))?.[0] ?? ''}`,
    );
    expect(hits).toEqual([]);
  });

  it('no resolve, confirm-tick, pin or progress-row hooks', () => {
    const hooks =
      /data-(comment-resolve|checkpoint[\w-]*|add-pin|cancel-pin|pin-[\w-]+|open-comments-chip|comment-bar)\b|CheckpointCircle|PinOverlay|CheckpointProgress|comment_batch_create|resolveComment|checkpointAccept/;
    const hits = SCREENS.filter((rel) => rel !== 'components/comments/Comments.tsx')
      .filter((rel) => hooks.test(code(read(rel))))
      .map((rel) => `${rel}: ${hooks.exec(code(read(rel)))?.[0] ?? ''}`);
    expect(hits).toEqual([]);
    // Comments keeps comment_batch_create only for the Pipeline's reason path, never renders it.
    const comments = code(read('components/comments/Comments.tsx'));
    expect(comments).not.toMatch(
      /CheckpointCircle|data-comment-resolve|resolveComment|checkpointAccept/,
    );
    expect(comments).not.toMatch(/runCreateCommentBatch\(supabase/);
  });

  it('Send for review again sends with no warning', () => {
    const decisions = code(read('components/pages/pcs/use-post-decisions.tsx'));
    expect(decisions).not.toContain('countOpenThreads');
    expect(decisions).not.toContain('sendAnywayTitle');
  });
});

// Thread polish 1 (11 Nov 2026): asset_versions and assets have two foreign
// keys between them, so the comment files embed must name its column or
// PostgREST answers HTTP 300 and every file draws as "Attachment / File".
describe('Thread polish 1: comment files embed and thread scroll', () => {
  it('a comment forward goes through the one helper and never drops its attachment ids', async () => {
    const { commentForwardRecord } = await import('@/lib/chat/forward-comment');
    const record = commentForwardRecord(
      {
        body: '',
        attachments: [
          { assetId: 'v1', name: 'Deck.pdf', mime: 'application/pdf' },
          { assetId: 'v2', name: '', mime: '' },
        ],
      },
      { id: 'm1', channelId: 'ch1', traceId: 't1' },
    );
    expect(record.attachmentAssetIds).toEqual(['v1', 'v2']);
    expect(Object.keys(record.attachmentMeta ?? {})).toEqual(['v1', 'v2']);
    expect(record.forwardedFromMessageId).toBeNull();
    // Both callers send a comment through forwardComment; neither builds its own send.
    const screen = code(read('components/comments/Comments.tsx'));
    const catchUp = code(read('components/catch-up/CatchUpActionLayer.tsx'));
    expect(screen).toContain('forwardComment({');
    expect(catchUp).toContain('forwardComment({');
    expect(catchUp).not.toContain('attachmentAssetIds: []');
    expect(screen).toContain('row.attachment_asset_ids ?? []');
  });

  it('the comment-file select keeps the !asset_id hint', () => {
    const files = code(read('components/comments/comment-files.ts'));
    expect(files).toContain('assets!asset_id(display_name, filename)');
    expect(files).not.toMatch(/[ ,]assets\(/);
  });

  it('the comment thread reuses chat stick-to-bottom (no second scroll core)', () => {
    const comments = code(read('components/comments/Comments.tsx'));
    expect(comments).toContain("from '@/lib/chat/stick-to-bottom'");
    expect(comments).toContain('ref={threadScrollRef}');
    expect(comments).toContain('fillBeside={postColumnRight}');
  });
});

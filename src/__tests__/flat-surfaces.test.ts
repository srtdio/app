// Guard: in-content surfaces are flat; frames only on floating layers
// (CLAUDE.md Lighting, 8 Nov 2026). A lit-card / lit-card-muted class may
// appear only in the KEEP files below (chat bubbles and what sits inside them,
// file / link / pending tiles, fields, the platform preview mocks, media, the
// Bone lit names). Any new one elsewhere fails CI: flatten it (hairline rows,
// no panel fill, no border box) or add it here with its reason.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cardSurface, CARD_COVER } from '@/components/ui/Card';

const SRC = fileURLToPath(new URL('../', import.meta.url));

/** file -> why it keeps a lit-card frame. */
export const FLAT_KEEP: Record<string, string> = {
  'components/chat/FileBubble.tsx': 'inside a chat bubble',
  'components/chat/MessageAttachments.tsx': 'attachment fallback tile inside a bubble',
  'components/chat/MessageThread.tsx': 'chat bubbles',
  'components/chat/VoiceDraft.tsx': 'composer tray draft, the PendingChip frame',
  'components/onboarding/AvatarCropper.tsx': 'media crop stage',
  'components/pages/activity/ThreadsListScreen.tsx':
    'Threads list band, Shubham approved 10 Nov 2026',
  'components/preview/PlatformPreviewPanel.tsx': 'mimics a platform feed',
  'components/preview/PostMock.tsx': 'mimics a platform feed',
  'components/ui/ChatCard.tsx': 'the chat bubble card',
  'components/ui/FileTile.tsx': 'file tile part',
  'components/ui/Input.tsx': 'field focus',
  'components/ui/LinkPreviewCard.tsx': 'link preview picture part',
  'components/ui/PendingChip.tsx': 'pending attachment part',
  'lib/motion/react.tsx': 'Bone lit name list (the type, not a surface)',
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : files(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const LIT_CARD = /(^|['"`\s:=])lit-card(-muted)?(?=$|['"`\s])/;

describe('flat surfaces: lit-card only in the KEEP list', () => {
  it('no lit-card / lit-card-muted outside FLAT_KEEP', () => {
    const hits: string[] = [];
    for (const full of files(SRC)) {
      const rel = relative(SRC, full).split(sep).join('/');
      if (rel in FLAT_KEEP) continue;
      readFileSync(full, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
          if (LIT_CARD.test(line)) hits.push(`${rel}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('ui/Card is flat at the source: hairline, no radius, no fill, no lit-card', () => {
    const plain = cardSurface();
    expect(plain).toContain('border-b border-border');
    expect(plain).not.toMatch(/rounded|bg-panel|lit-card/);
    expect(cardSurface(true)).not.toMatch(/lit-card-muted|bg-panel/);
    expect(CARD_COVER).not.toMatch(/rounded/);
  });
});

// Button system regression: the composer's plus, emoji and voice draft
// controls render the shared 44px recipe (round for plus / send), the tray's
// Tasks tile keeps its hooks, and the composer source keeps mic and send round.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerTray, TrayGrid, trayTiles } from '@/components/chat/ComposerTray';
import { ComposerEmoji } from '@/components/chat/ComposerEmoji';
import { voiceDraftView } from '@/components/chat/VoiceDraft';

const buttons = (html: string): string[] => html.match(/<button[^>]*>/g) ?? [];

function expectOnSystem(tag: string): void {
  expect(tag).toContain('h-11');
  expect(tag).not.toMatch(/\bh-9\b|\bh-10\b|\bh-12\b|rounded-md|rounded-xl|font-semibold/);
}

describe('composer buttons', () => {
  it('plus: round secondary, 44px', () => {
    const [plus] = buttons(renderToStaticMarkup(<ComposerTray layout="touch" onPick={() => {}} />));
    expect(plus).toBeDefined();
    expectOnSystem(plus ?? '');
    expect(plus).toContain('rounded-full w-11 px-0');
    expect(plus).toContain('lit-btn-secondary');
    expect(plus).toContain('aria-label="Add attachment"');
  });

  it('the Tasks tile: last, the tour key, the unseen dot and "Tasks, new"', () => {
    const tiles = trayTiles('touch', { tasks: { unseen: true } });
    expect(tiles.map((t) => t.id).at(-1)).toBe('tasks');
    const html = renderToStaticMarkup(<TrayGrid tiles={tiles} onPick={() => {}} />);
    const task = buttons(html).find((tag) => tag.includes('data-tray-tile="tasks"')) ?? '';
    expect(task).toContain('data-induction="chat-tasks"');
    expect(task).toContain('data-task-unseen=""');
    // The unseen dot rides in the name too ("new"), never colour alone.
    expect(task).toContain('aria-label="Tasks, new"');
    expect(html).toContain('data-task-dot=""');
    const seen = renderToStaticMarkup(
      <TrayGrid tiles={trayTiles('touch', { tasks: { unseen: false } })} onPick={() => {}} />,
    );
    expect(seen).not.toContain('data-task-dot');
    expect(trayTiles('touch').map((t) => t.id)).not.toContain('tasks');
  });

  it("emoji: a bare 44 circle (the composer row's side treatment)", () => {
    const [emoji] = buttons(renderToStaticMarkup(<ComposerEmoji onPick={() => {}} />));
    expectOnSystem(emoji ?? '');
    expect(emoji).toContain('rounded-full');
    expect(emoji).not.toContain('rounded-lg');
    expect(emoji).toContain('w-11');
    expect(emoji).not.toContain('lit-btn-');
  });

  it('voice draft: play and delete 44x44, send round primary', () => {
    const html = renderToStaticMarkup(
      voiceDraftView({
        durationMs: 3_000,
        playing: false,
        busy: false,
        onPlay: () => {},
        onSend: () => {},
        onDelete: () => {},
      }),
    );
    const tags = buttons(html);
    expect(tags).toHaveLength(3);
    for (const tag of tags) expectOnSystem(tag);
    const send = tags.find((t) => t.includes('data-voice-draft-send')) ?? '';
    expect(send).toContain('rounded-full w-11 px-0');
    expect(send).toContain('bg-accent');
  });

  it('the composer source keeps mic and send round and primary', () => {
    const src = readFileSync(fileURLToPath(new URL('./Composer.tsx', import.meta.url)), 'utf8');
    expect(src).toMatch(/variant="primary"\s+shape="round"\s+aria-label="Record voice note"/);
    // Send stays round in every state (an edit save spins in place, ui/Composer).
    expect(src).toMatch(/type="submit"\s+variant="primary"\s+shape="round"/);
    // No schedule chevron: Send is one plain round button.
    expect(src).not.toContain('Schedule options');
    // The composer dock is lit, its neutral top border colour dropped.
    expect(src).toContain('border-t bg-panel px-3 py-2 lit-dock');
    expect(src).not.toMatch(/size="lg"/);
  });
});

describe('ComposerTray compact (ui/WritingBox rows)', () => {
  it('a 36 grey circle on a 44 tall hit; the plus still turns into the X', () => {
    const html = renderToStaticMarkup(
      <ComposerTray compact layout="touch" onPick={() => undefined} />,
    );
    expect(html).toContain('h-11');
    expect(html).toContain('w-9 min-w-9');
    expect(html).toContain('w-full items-center justify-center rounded-full');
    expect(html).toContain('py-1');
    expect(html).toContain('bg-panel-3 text-fg-2');
    expect(html).toContain('aria-label="Add attachment"');
  });
});

// Button system regression: the composer's plus, task, emoji and voice draft
// controls render the shared 44px recipe (round for plus / task / send), and
// the composer source keeps mic, send and the schedule chevron round.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComposerTray } from '@/components/chat/ComposerTray';
import { ComposerEmoji } from '@/components/chat/ComposerEmoji';
import { TaskButton } from '@/components/chat/tasks/TaskButton';
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
    expect(plus).toContain('border-border');
    expect(plus).toContain('aria-label="Add attachment"');
  });

  it('task: round secondary, 44px, keeps its data attributes', () => {
    const [task] = buttons(renderToStaticMarkup(<TaskButton unseen onOpen={() => {}} />));
    expectOnSystem(task ?? '');
    expect(task).toContain('rounded-full w-11 px-0');
    expect(task).toContain('bg-panel');
    expect(task).toContain('data-task-button=""');
    expect(task).toContain('data-task-unseen=""');
    expect(task).toContain('aria-label="Tasks"');
  });

  it('emoji: 44x44, 8px radius, ghost', () => {
    const [emoji] = buttons(renderToStaticMarkup(<ComposerEmoji onPick={() => {}} />));
    expectOnSystem(emoji ?? '');
    expect(emoji).toContain('rounded-lg');
    expect(emoji).toContain('w-11');
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

  it('the composer source keeps mic, send and the chevron round and primary', () => {
    const src = readFileSync(fileURLToPath(new URL('./Composer.tsx', import.meta.url)), 'utf8');
    expect(src).toMatch(/variant="primary"\s+shape="round"\s+aria-label="Record voice note"/);
    expect(src).toMatch(/variant="primary"\s+shape="round"\s+aria-label="Schedule options"/);
    expect(src).toMatch(/variant="primary"\s+shape=\{scheduleBusy \? 'default' : 'round'\}/);
    expect(src).toContain("showChevron && 'rounded-r-none'");
    expect(src).not.toMatch(/size="lg"/);
  });
});

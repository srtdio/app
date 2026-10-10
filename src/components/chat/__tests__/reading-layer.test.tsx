import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ComposerTray,
  DRAFT_UNAVAILABLE_LABEL,
  PLAN_UNAVAILABLE_LABEL,
  TrayGrid,
  channelHasClient,
  draftTileEnabled,
  trayTiles,
} from '@/components/chat/ComposerTray';
import { ComposerEmoji, showsEmojiButton } from '@/components/chat/ComposerEmoji';
import { planTileEnabled } from '@/components/chat/plan-card';
import {
  LatestButton,
  ReadByLine,
  SeenLine,
  sentLine,
  UnreadDivider,
  UnreadPill,
} from '@/components/chat/ReadingLayer';
import { chatLayout } from '@/components/chat/chat-type';

const EM_DASH = String.fromCharCode(0x2014);

describe('T8 tray and emoji button by pointer', () => {
  it('the D1 tiles in order on touch and laptop, Schedule last', () => {
    const laptop = chatLayout({ finePointer: true, widthPx: 1280 });
    const touch = chatLayout({ finePointer: false, widthPx: 390 });
    const ids = ['photos', 'file', 'assets', 'brief', 'post', 'draft', 'plan', 'schedule'];
    expect(trayTiles(laptop).map((t) => t.id)).toEqual(ids);
    expect(trayTiles(touch).map((t) => t.id)).toEqual(ids);
    expect(trayTiles(touch, { draft: true }).map((t) => t.id)).toEqual(ids);
    expect(trayTiles(touch, { plan: true }).map((t) => t.id)).toEqual(ids);
    expect(trayTiles(touch).map((t) => t.label)).toEqual([
      'Photos',
      'File',
      'Assets',
      'Brief',
      'Post',
      'Draft',
      'Plan',
      'Schedule',
    ]);
  });

  it('Plan is disabled unless the tray is told it is live (agency side only)', () => {
    const planOf = (opts: { plan?: boolean }) =>
      trayTiles('touch', opts).find((t) => t.id === 'plan');
    expect(planOf({})).toMatchObject({ disabled: true, ariaLabel: PLAN_UNAVAILABLE_LABEL });
    expect(planOf({ plan: false })).toMatchObject({ disabled: true });
    expect(planOf({ plan: true })?.disabled).toBeUndefined();
    // Client viewer and an unknown side (first paint) keep it off; agency turns it on.
    expect(planTileEnabled('client')).toBe(false);
    expect(planTileEnabled('unknown')).toBe(false);
    expect(planTileEnabled('agency')).toBe(true);
    expect(planOf({ plan: planTileEnabled('client') })?.disabled).toBe(true);
    expect(planOf({ plan: planTileEnabled('unknown') })?.disabled).toBe(true);
    expect(planOf({ plan: planTileEnabled('agency') })?.disabled).toBeUndefined();
  });

  it('Draft is disabled unless the tray is told it is live', () => {
    const draftOf = (opts: { draft?: boolean }) =>
      trayTiles('touch', opts).find((t) => t.id === 'draft');
    expect(draftOf({})).toMatchObject({ disabled: true, ariaLabel: DRAFT_UNAVAILABLE_LABEL });
    expect(draftOf({ draft: false })).toMatchObject({ disabled: true });
    expect(draftOf({ draft: true })?.disabled).toBeUndefined();
    expect(
      trayTiles('touch')
        .filter((t) => t.disabled === true)
        .map((t) => t.id),
    ).toEqual(['draft', 'plan']);
    expect(
      trayTiles('touch', { plan: true })
        .filter((t) => t.disabled === true)
        .map((t) => t.id),
    ).toEqual(['draft']);
  });

  it('Draft is live only for an agency-side viewer in a chat known to have no client', () => {
    // Client viewer: never.
    expect(draftTileEnabled('client', false)).toBe(false);
    // Agency viewer in a chat with a client: no.
    expect(draftTileEnabled('agency', true)).toBe(false);
    // Unknown chat (members loading or failed) or unknown side: no (first paint final).
    expect(draftTileEnabled('agency', null)).toBe(false);
    expect(draftTileEnabled('unknown', false)).toBe(false);
    // Agency viewer in an agency-only chat, or in notes (no other members): yes.
    expect(draftTileEnabled('agency', false)).toBe(true);
    expect(draftTileEnabled('agency', channelHasClient([]))).toBe(true);
  });

  it('channelHasClient reads the other members role list; null while unknown', () => {
    expect(channelHasClient(null)).toBeNull();
    expect(channelHasClient([])).toBe(false);
    expect(channelHasClient([{ role: 'agency' }, { role: 'admin' }])).toBe(false);
    expect(channelHasClient([{ role: 'agency' }, { role: 'client' }])).toBe(true);
  });

  it('the grid: 4 columns (two rows of 4), every tile at least 44x44, a disabled Draft faded and inert', () => {
    const picks: string[] = [];
    const html = renderToStaticMarkup(
      <TrayGrid tiles={trayTiles('touch')} onPick={(id) => picks.push(id)} />,
    );
    expect(html).toContain('grid-cols-4');
    expect(html.match(/data-tray-tile=/g)).toHaveLength(8);
    expect(html.match(/min-h-\[72px\] min-w-\[44px\]/g)).toHaveLength(8);
    const plan = /<button[^>]*data-tray-tile="plan"[^>]*>/.exec(html)?.[0] ?? '';
    expect(plan).toContain('disabled=""');
    expect(plan).toContain('aria-disabled="true"');
    expect(plan).toContain(`aria-label="${PLAN_UNAVAILABLE_LABEL}"`);
    const draft = /<button[^>]*data-tray-tile="draft"[^>]*>/.exec(html)?.[0] ?? '';
    expect(draft).toContain('disabled=""');
    expect(draft).toContain('aria-disabled="true"');
    expect(draft).toContain(`aria-label="${DRAFT_UNAVAILABLE_LABEL}"`);
    expect(draft).toContain('disabled:opacity-50');
    const live = renderToStaticMarkup(
      <TrayGrid tiles={trayTiles('touch', { draft: true })} onPick={() => undefined} />,
    );
    const liveDraft = /<button[^>]*data-tray-tile="draft"[^>]*>/.exec(live)?.[0] ?? '';
    expect(liveDraft).not.toContain('disabled=""');
    expect(liveDraft).not.toContain('aria-disabled');
    // The disabled tile's handler is a no-op even if invoked directly.
    const el = TrayGrid({ tiles: trayTiles('touch'), onPick: (id) => picks.push(id) });
    const buttons = (el.props as { children: Array<{ props: { onClick: () => void } }> }).children;
    buttons[5]?.props.onClick();
    expect(picks).toEqual([]);
    buttons[6]?.props.onClick();
    expect(picks).toEqual([]);
    buttons[4]?.props.onClick();
    expect(picks).toEqual(['post']);
  });

  it('the composer maps every tile id explicitly (no fallthrough to the post picker)', () => {
    const src = readFileSync(fileURLToPath(new URL('../Composer.tsx', import.meta.url)), 'utf8');
    for (const id of ['photos', 'file', 'assets', 'brief', 'post', 'draft', 'plan', 'schedule']) {
      expect(src).toContain(`case '${id}':`);
    }
    expect(src).toContain("if (draftEnabled) openPicker('drafts');");
    expect(src).toContain('if (planEnabled) props.onOpenPlanCompose?.();');
    expect(src).toContain('plan={planEnabled}');
    // Library picks count as attachments everywhere the draft is weighed:
    // Send vs mic, Send enabled, and the schedule preview.
    expect(src).toContain('attachmentCount: pending.length + library.length,');
    expect(src).toContain('fileCount: pending.length + library.length,');
    expect(src).toContain('draftFileCounts(pending, library)');
    expect(src).toContain('draft={draftEnabled}');
  });

  it('the emoji button is hidden on a coarse pointer (touch, any width)', () => {
    expect(showsEmojiButton(chatLayout({ finePointer: false, widthPx: 1024 }))).toBe(false);
    expect(showsEmojiButton(chatLayout({ finePointer: true, widthPx: 1280 }))).toBe(true);
  });

  it('the composer gates the emoji button on that rule', () => {
    const src = readFileSync(fileURLToPath(new URL('../Composer.tsx', import.meta.url)), 'utf8');
    expect(src).toContain('showsEmojiButton(layout)');
    expect(src).not.toContain('IconPaperclip');
  });

  it('the plus button is a 44x44 circle, collapsed tray not rendered', () => {
    const html = renderToStaticMarkup(<ComposerTray layout="touch" onPick={() => undefined} />);
    expect(html).toContain('h-11 w-11');
    expect(html).toContain('rounded-full');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-tray=""');
  });

  it('the emoji popover is closed until pressed', () => {
    const html = renderToStaticMarkup(<ComposerEmoji onPick={() => undefined} />);
    expect(html).toContain('data-emoji-button');
    expect(html).not.toContain('data-emoji-popover');
  });
});

describe('reading layer elements', () => {
  it('divider and pill read "N unread" with mono digits', () => {
    const divider = renderToStaticMarkup(<UnreadDivider count={5} />);
    expect(divider).toContain('font-mono');
    expect(divider).toContain('5 unread');
    const pill = renderToStaticMarkup(<UnreadPill count={5} visible onJump={() => undefined} />);
    expect(pill).toContain('h-11');
    expect(pill).toContain('font-mono');
    expect(pill).toContain('bg-panel');
    expect(pill).toContain('border-border');
  });

  it('latest button is 44px, solid panel, with a count badge', () => {
    const html = renderToStaticMarkup(<LatestButton visible count={3} onTap={() => undefined} />);
    expect(html).toContain('h-11 w-11');
    expect(html).toContain('data-latest-count');
    const none = renderToStaticMarkup(
      <LatestButton visible={false} count={0} onTap={() => undefined} />,
    );
    expect(none).toContain('opacity-0');
    expect(none).not.toContain('data-latest-count');
  });

  it('Seen line is 11/15 muted with a mono time', () => {
    const html = renderToStaticMarkup(
      <SeenLine lastReadAt="2026-10-02T10:05:00Z" timeZone="UTC" />,
    );
    expect(html).toContain('text-[11px] leading-[15px]');
    expect(html).toContain('Seen');
    expect(html).toContain('font-mono');
  });

  it('Read by line is a real button with a 44px hit area', () => {
    const html = renderToStaticMarkup(
      <ReadByLine label="Read by 2 of 5" onOpen={() => undefined} />,
    );
    expect(html).toContain('<button');
    expect(html).toContain('h-11');
  });

  it('sent line reads "Sent <day> at <time>", no em-dashes', () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    const line = sentLine('2026-10-02T10:05:00Z', 'UTC', now);
    expect(line.startsWith('Sent Today at ')).toBe(true);
    expect(line).not.toContain(EM_DASH);
  });
});

describe('first paint final', () => {
  it('the first page waits for the read cursors, so receipts never pop in after', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../MessageThread.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).toContain("props.readState?.status === 'loading'");
  });
});

describe('T9 token hygiene', () => {
  it('the new chat files carry no hex or theme-variant literals', () => {
    for (const name of [
      'ReadingLayer.tsx',
      'ComposerTray.tsx',
      'ComposerEmoji.tsx',
      'ChatTabSignals.tsx',
    ]) {
      const src = readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');
      expect(src.includes(String.fromCharCode(35))).toBe(false);
      expect(src.includes(['dark', ':'].join(''))).toBe(false);
    }
  });
});

// Regression (iPhone, 3 Oct): a backdrop-filter layer (the jump pill and the
// always-mounted scroll-to-latest button) over the thread's scroll container
// left the message area unpainted on iOS WebKit, showing stale composer tiles.
// The floating surfaces are solid panel now; no chat surface may blur again.
describe('T1 no backdrop-filter over the thread (iOS WebKit paint)', () => {
  const BLUR = ['backdrop', '-blur'].join('');
  const SUPPORTS = ['supports-[', 'backdrop'].join('');
  const FILTER_CSS = ['backdrop', '-filter:'].join('');

  it('the pill and the latest button render without any backdrop class', () => {
    for (const html of [
      renderToStaticMarkup(<UnreadPill count={2} visible onJump={() => undefined} />),
      renderToStaticMarkup(<UnreadPill count={2} visible={false} onJump={() => undefined} />),
      renderToStaticMarkup(<LatestButton visible count={1} onTap={() => undefined} />),
      renderToStaticMarkup(<LatestButton visible={false} count={0} onTap={() => undefined} />),
    ]) {
      expect(html).not.toContain('backdrop');
      expect(html).toContain('bg-panel');
    }
  });

  it('no chat component or the thread uses a backdrop blur or filter', () => {
    for (const name of [
      'ReadingLayer.tsx',
      'MessageThread.tsx',
      'Composer.tsx',
      'ComposerTray.tsx',
    ]) {
      const src = readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');
      expect(src.includes(BLUR)).toBe(false);
      expect(src.includes(SUPPORTS)).toBe(false);
      expect(src.includes(FILTER_CSS)).toBe(false);
    }
  });

  it('the glass token is gone from the token file', () => {
    const css = readFileSync(fileURLToPath(new URL('../../../index.css', import.meta.url)), 'utf8');
    expect(css.includes('--glass')).toBe(false);
  });
});

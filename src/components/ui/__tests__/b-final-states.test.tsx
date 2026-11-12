// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ComposerFrame, type ComposerState } from '@/components/ui/Composer';
import { Button } from '@/components/ui/Button';
import {
  LANE_BOTTOM,
  LANE_BOTTOM_CLEAR,
  LANE_STRIP,
  LANE_TOP,
  LANE_TOP_CLEAR,
} from '@/components/ui/layout';
import { LatestButton, UnreadPill } from '@/components/chat/ReadingLayer';
import { holdTipView } from '@/components/chat/ThreadHoldTip';

// Phase 2 (B-final): every moment state keeps its footprint, and the thread's
// floating controls each own a lane.

const ROOT = join(process.cwd(), 'src');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const STATES: ComposerState[] = [
  { kind: 'idle' },
  { kind: 'recording', elapsed: '0:07' },
  { kind: 'sending' },
  { kind: 'scheduling' },
];

function composer(state: ComposerState): HTMLElement {
  const html = renderToStaticMarkup(
    <ComposerFrame
      state={state}
      leading={<button type="button" aria-label="Add attachment" />}
      discard={<button type="button" aria-label="Cancel recording" />}
      input={<textarea aria-label="Message" />}
      side={
        <>
          <button type="button" aria-label="Emoji" />
          <button type="button" aria-label="Tasks" />
        </>
      }
      send={
        <Button
          type="submit"
          variant="primary"
          shape="round"
          aria-label="Send"
          busy={state.kind === 'sending'}
        >
          S
        </Button>
      }
    />,
  );
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

describe('ui/Composer keeps its row in every state', () => {
  it('the row, the field and the slots keep the same classes across states', () => {
    const rows = STATES.map((s) => composer(s).querySelector('[data-composer-row]')!);
    const fields = STATES.map((s) => composer(s).querySelector('[data-composer-field]')!);
    for (const row of rows) expect(row.className).toBe(rows[0]!.className);
    // The field's height (min-h-11) and line hold; only the in-field padding may differ.
    for (const field of fields) expect(field.className).toContain('min-h-11');
    // Same number of slots in every state: leading/bin, field, side, send.
    for (const row of rows) expect(row.children).toHaveLength(rows[0]!.children.length);
  });

  it('recording keeps the side slot (invisible, hidden from AT) so the field never widens', () => {
    const rec = composer({ kind: 'recording', elapsed: '0:07' });
    const side = rec.querySelector('[data-composer-side]');
    expect(side).not.toBeNull();
    expect(side!.className).toContain('invisible');
    expect(side!.getAttribute('aria-hidden')).toBe('true');
    const idle = composer({ kind: 'idle' }).querySelector('[data-composer-side]');
    expect(idle!.className).not.toContain('invisible');
    expect(idle!.className.replace(' invisible', '')).toBe(
      side!.className.replace(' invisible', ''),
    );
  });

  it('sending: the send slot is Button busy (label kept, arc over it)', () => {
    const send = composer({ kind: 'sending' }).querySelector('[aria-label="Send"]')!;
    expect(send.getAttribute('aria-busy')).toBe('true');
    expect(send.querySelector('[data-busy-label]')).not.toBeNull();
  });
});

describe('chat Tasks header reserves the save state width', () => {
  const src = read('components/chat/tasks/TaskSheet.tsx');
  const slot = src.slice(src.indexOf('data-task-save-slot'), src.indexOf('<ActionMenu title='));
  it('an invisible "Saving…" and an invisible Retry hold the slot when idle', () => {
    expect(slot).toMatch(
      /aria-hidden="true"\s+className="invisible col-start-1 row-start-1[^"]*"\s*>\s*\{SAVING_LABEL\}/,
    );
    expect(slot).toMatch(
      /data-task-save-reserve="retry"\s+className="invisible col-start-1 row-start-1[^"]*"\s*>\s*\{RETRY_LABEL\}/,
    );
    // The live state shares the same grid cell.
    expect(slot).toContain('className="col-start-1 row-start-1 flex items-center"');
  });
});

describe('thread lanes (ui/layout)', () => {
  it('the unread pill sits in LANE_TOP, the latest button in LANE_BOTTOM', () => {
    const pill = renderToStaticMarkup(<UnreadPill count={2} visible onJump={() => {}} />);
    const host = document.createElement('div');
    host.innerHTML = pill;
    const top = host.querySelector('[data-lane="top"]')!;
    for (const cls of LANE_TOP.split(' ')) expect(top.classList).toContain(cls);
    expect(top.querySelector('[data-unread-pill]')).not.toBeNull();

    host.innerHTML = renderToStaticMarkup(<LatestButton visible count={3} onTap={() => {}} />);
    const bottom = host.querySelector('[data-lane="bottom"]')!;
    for (const cls of LANE_BOTTOM.split(' ')) expect(bottom.classList).toContain(cls);
    expect(bottom.querySelector('[data-latest-button]')).not.toBeNull();
  });

  it('the lanes never meet: top centre, bottom trailing, the tip strip in flow', () => {
    expect(LANE_TOP).toContain('top-2');
    expect(LANE_BOTTOM).toContain('bottom-3');
    expect(LANE_BOTTOM).toContain('right-3');
    // Phone: the key sits on the 16 page edge (R5); md+ keeps the 12 chat edge.
    expect(LANE_BOTTOM.split(' ')).toContain('max-md:right-4');
    expect(LANE_BOTTOM).not.toMatch(/(^|\s)md:right-/);
    expect(LANE_STRIP).not.toMatch(/absolute|fixed/);
    const tip = document.createElement('div');
    tip.innerHTML = renderToStaticMarkup(holdTipView(() => {}));
    const strip = tip.querySelector('[data-lane="strip"]')!;
    for (const cls of LANE_STRIP.split(' ')) expect(strip.classList).toContain(cls);
  });

  it('the thread list keeps the lanes clear wherever it lands a row', () => {
    const src = read('components/chat/MessageThread.tsx');
    const list = src.slice(
      src.indexOf('export const THREAD_LIST_CLASS'),
      src.indexOf(');', src.indexOf('export const THREAD_LIST_CLASS')),
    );
    expect(list).toContain('LANE_TOP_CLEAR');
    expect(list).toContain('LANE_BOTTOM_CLEAR');
    expect(LANE_TOP_CLEAR).toMatch(/^scroll-pt-/);
    expect(LANE_BOTTOM_CLEAR).toMatch(/^scroll-pb-/);
  });
});

describe('busy keeps the width: no label swaps on busy buttons', () => {
  const SITES: Array<[string, RegExp]> = [
    ['components/auth/AuthCallbackPage.tsx', /'Signing in'/],
    ['components/auth/AcceptInvitePage.tsx', /\?\s*'Joining'/],
    ['components/shell/WorkspaceSwitcher.tsx', /'Creating\.\.\.'/],
    ['components/chat/GroupInfoSheet.tsx', /busy \? '(Saving|Adding)'/],
    ['components/chat/PlanComposeScreen.tsx', /CREATING_LABEL/],
    ['components/chat/VoiceDraft.tsx', /data-voice-draft-send=""[^>]*disabled=\{props\.busy\}/s],
    ['components/settings/UsernameField.tsx', /saving \? 'Saving'/],
    ['components/comments/Comments.tsx', /isResolving \? 'Saving…'|loadingMore \? 'Loading'/],
    ['components/pages/pcs/PostReadyNotice.tsx', /'Sending…'/],
    ['components/pages/pcs/PostGallery.tsx', /'Saving…'/],
    ['components/pages/NotificationsPage.tsx', /loadingMore \? 'Loading'/],
    ['components/pages/CreatePostSheet.tsx', /'Saving…'|'Sending…'|'Creating…'/],
    ['components/pages/CreateBriefSheet.tsx', /'Creating…'/],
    ['components/pages/assets/AssetLightbox.tsx', /savingName \? 'Saving'/],
    ['components/pages/settings/ApprovedAddressesSection.tsx', /'Adding'/],
    ['components/pages/settings/MembersInviteForm.tsx', /submitting \? 'Sending'/],
    ['components/pages/plan-tab/PlanTabList.tsx', /'Loading'/],
    ['components/pages/create/AttachmentsField.tsx', /linkBusy \? 'Adding'/],
    ['components/induction/InductionGuide.tsx', /CLEAR_CARD_COPY\.clearing/],
  ];
  for (const [rel, swap] of SITES) {
    it(rel, () => {
      expect(read(rel)).not.toMatch(swap);
    });
  }
});

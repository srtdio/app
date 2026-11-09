// @vitest-environment jsdom
// X7 fix 11 (FB2): the chat's aria-modal pages (Contact, Group info)
// use X1's useModalFocus through ModalPanel: focus moves in, Tab stays inside,
// focus returns to the opener on close. The thread view and status drawer own
// focus the same way without aria-modal (their Escape reads aria-modal).
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ModalPanel } from '@/components/chat/ModalPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('X7 FB2: modal chat pages own focus', () => {
  it('focus moves in on open and returns to the opener on close', () => {
    const opener = document.createElement('button');
    opener.textContent = 'Open';
    document.body.appendChild(opener);
    opener.focus();
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root?.render(
        <ModalPanel aria-label="Group info" data-group-page="">
          <button type="button">Close group info</button>
          <button type="button">Leave group</button>
        </ModalPanel>,
      ),
    );
    const panel = document.querySelector('[role="dialog"]');
    expect(panel?.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement?.textContent).toBe('Close group info');
    act(() => root?.render(<span />));
    expect(document.activeElement).toBe(opener);
  });

  it('Contact and Group info pages are ModalPanels; thread view uses useModalFocus, the drawer is a Sheet', () => {
    expect(source('../ContactSheet.tsx')).toContain('<ModalPanel');
    expect(source('../GroupInfoSheet.tsx')).toContain('<ModalPanel');
    expect(source('../ThreadView.tsx')).toContain('useModalFocus(rootRef, true');
    expect(source('../StatusTicker.tsx')).toContain('useModalFocus(panelRef,');
    // The reaction drawer is ui/EmojiSheet on ui/Sheet (its own modal focus).
    expect(source('../MessageActionMenu.tsx')).toContain('<AddReactionSheet');
    expect(source('../MessageActionMenu.tsx')).not.toContain('onKeyDown: trapTab');
  });
});

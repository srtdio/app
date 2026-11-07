// Layout B-final, shell + icons + chat sheets: the shell header and the chat
// sheets render the shared parts (HeaderBar, the one sheet frame), the
// trailing rule stays on the part, and a row or bar keeps its height across
// states.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HeaderBar } from '@/components/ui/HeaderBar';
import { IconButton } from '@/components/ui/IconButton';
import { SHEET_FRAME } from '@/components/ui/Sheet';
import { ICON_SIZE, IconAlarmClock, IconSearch, IconX, strokeFor } from '@/components/ui/icons';
import { PageHead } from '@/components/shell/PageHead';
import { selectionHeaderSlots } from '@/components/chat/SelectionBar';

const html = (node: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(node);

function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const noop = (): void => undefined;

describe('icons: stroke per size, computed in the icon base', () => {
  it('2 at 12-16, 1.85 at 18-20, 1.6 at 22-28', () => {
    expect([12, 16, 18, 20, 22, 28].map(strokeFor)).toEqual([2, 2, 1.85, 1.85, 1.6, 1.6]);
    expect(html(<IconSearch size={ICON_SIZE.inline} />)).toContain('stroke-width="2"');
    expect(html(<IconSearch size={ICON_SIZE.control} />)).toContain('stroke-width="1.85"');
    expect(html(<IconAlarmClock size={ICON_SIZE.tray} />)).toContain('stroke-width="1.6"');
  });
});

describe('PageHead is the one header bar', () => {
  it('HeaderBar, title role, 56 tall, the route-focus h1', () => {
    const out = html(<PageHead title="Settings" />);
    expect(out).toContain('data-header-bar=""');
    expect(out).toMatch(
      /<h1 tabindex="-1" class="[^"]*text-lg font-semibold[^"]*focus:outline-none/,
    );
    expect(out).toContain('h-14');
    expect(out).not.toContain('md:h-16');
  });

  it('HeaderBar keeps a plain h1 unless routeFocus is set (additive slot)', () => {
    expect(html(<HeaderBar title="Group info" />)).not.toContain('tabindex');
  });

  it('the hidden form paints nothing but the sr-only h1', () => {
    expect(html(<PageHead title="Pipeline" hidden />)).toBe(
      '<h1 tabindex="-1" class="sr-only">Pipeline</h1>',
    );
  });
});

describe('Topbar edges', () => {
  it('the bar sits on GUTTER and the workspace name starts on the 16 edge', () => {
    const src = source('../Topbar.tsx');
    expect(src).toContain('GUTTER,');
    expect(src).not.toContain('px-3 md:px-4');
    expect(src).toContain('className="md:hidden -ml-4 min-w-0');
  });

  it('the operator Cockpit dot carries a name and a tooltip', () => {
    expect(source('../../cockpit/Cockpit.tsx')).toContain('title={dotLabel(level)}');
  });
});

describe('trailing rule: the part applies it, never the call site', () => {
  it('a trailing X in HeaderBar is pulled 12 by the part', () => {
    const out = html(
      <HeaderBar
        compact
        title="Switch workspace"
        actions={
          <IconButton label="Close" onClick={noop}>
            <IconX size={ICON_SIZE.control} />
          </IconButton>
        }
      />,
    );
    expect(out).toContain('[&amp;&gt;button.w-11:last-child]:-mr-3');
    expect(out).toContain('width="20"');
    const close = /<button[^>]*aria-label="Close"[^>]*>/.exec(out)?.[0] ?? '';
    expect(close).not.toContain('-mr-3');
  });

  it('WorkspaceSwitcher, Contact and Group info headers are HeaderBar in both modes', () => {
    expect(source('../WorkspaceSwitcher.tsx')).toContain('<HeaderBar');
    for (const file of ['../../chat/ContactSheet.tsx', '../../chat/GroupInfoSheet.tsx']) {
      const src = source(file);
      expect(src).toContain('title={select.selectHeader.title}');
      expect(src).not.toContain('px-2 md:px-4');
    }
  });

  it('select mode: the count is the title, Cancel a text action on the edge', () => {
    const slots = selectionHeaderSlots({ count: 2, onCancel: noop });
    const out = html(<HeaderBar compact title={slots.title} actions={slots.cancel} />);
    expect(out).toContain('data-selection-count=""');
    expect(out).toContain('2 selected');
    const cancel = /<button[^>]*data-selection-cancel=""[^>]*>/.exec(out)?.[0] ?? '';
    expect(cancel).not.toMatch(/(^|\s)w-11(\s|$)/);
    // Same bar height as the browse mode's header.
    expect(out).toContain('h-14');
    expect(html(<HeaderBar compact title="Contact info" onBack={noop} />)).toContain('h-14');
  });
});

describe('Tasks sheet: one frame, the height of what it holds', () => {
  it('TaskSheet takes the shared SHEET_FRAME (no own 88svh / 560 size)', () => {
    const src = source('../../chat/tasks/TaskSheet.tsx');
    expect(src).toContain(': SHEET_FRAME');
    expect(src).not.toContain('88svh');
    expect(src).not.toContain('w-[560px]');
    expect(SHEET_FRAME).toContain('max-h-[90svh]');
    expect(SHEET_FRAME).toContain('sm:w-sheet');
    expect(source('../../ui/Sheet.tsx')).toContain('SHEET_FRAME,');
  });
});

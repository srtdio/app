// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OnBehalfApproveView } from '@/components/ui/OnBehalfApproveSheet';
import { PlanOpenSendSheet } from '@/components/chat/PlanOpenSendSheet';

// B1: Sheet no longer prints busyLabel in its header, so a Sheet that is busy
// shows it on its primary Button (Button busy, aria-busy). One check per sheet
// the regression touched, plus a scan of every <Sheet busy=...>.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom gives import.meta.url a non-file scheme: resolve from the repo root.
const ROOT = join(process.cwd(), 'src');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function mount(node: Parameters<Root['render']>[0]): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(node);
    await new Promise((r) => setTimeout(r, 30));
  });
}

const busyButtons = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button[aria-busy="true"]'),
];

describe('busy sheets render a busy primary Button', () => {
  it('ui/OnBehalfApproveSheet: Approve', async () => {
    await mount(
      <OnBehalfApproveView
        open
        approvers={[{ userId: 'u1', name: 'Ana' }]}
        brand={null}
        selected="u1"
        onSelect={vi.fn()}
        busy
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(busyButtons().map((b) => b.dataset.onBehalfApprove)).toContain('');
  });

  it('chat/PlanOpenSendSheet: Open and send is busy and cannot fire twice', async () => {
    const go = vi.fn();
    await mount(
      <PlanOpenSendSheet
        ask={{ planId: 'p', planTitle: 'Week', channelId: 'c', chatName: 'Team' }}
        busy
        onClose={vi.fn()}
        onOpenAndSend={go}
      />,
    );
    const button = document.querySelector<HTMLButtonElement>('[data-plan-open-send-go]');
    expect(button?.getAttribute('aria-busy')).toBe('true');
    expect(button?.disabled).toBe(true);
    await act(async () => button?.click());
    expect(go).not.toHaveBeenCalled();
  });

  // Source checks for sheets that need app context to mount.
  const SOURCE: Array<[string, RegExp]> = [
    ['chat/IdeaShareFlow.tsx', /data-idea-share-show=""[^>]*?busy=\{busy\}/s],
    ['chat/NewChatSheet.tsx', /busy=\{busy\}\s+onClick=\{\(\) => void submitDm\(\)\}/],
    ['chat/NewChatSheet.tsx', /busy=\{busy\}\s+onClick=\{\(\) => void submitGroup\(\)\}/],
    ['pages/pcs/PinAnnotationComposer.tsx', /busy=\{submitting\}\s+disabled=\{!canPost\}/],
    ['pages/pcs/CaptionAnnotationComposer.tsx', /busy=\{submitting\}\s+disabled=\{!canPost\}/],
    ['pages/plan-tab/BankAddSheet.tsx', /data-bank-add-go=""\s+busy=\{busy\}/],
    ['pages/plan-tab/BankList.tsx', /data-bank-plan-it-go=""\s+busy=\{props\.busy\}/],
    ['pages/plan-tab/BankList.tsx', /data-bank-make-plan=""\s+busy=\{props\.busy\}/],
    ['pages/plan-tab/BankList.tsx', /data-bank-shared-go=""\s+busy=\{props\.busy\}/],
    ['pages/plan-tab/BankPickSheet.tsx', /aria-busy=\{busy && pickedId === idea\.id/],
    ['pages/pcs/PostDetailsSheet.tsx', /data-new-bucket-create=""\s+busy=\{newBucketBusy\}/],
    ['pages/assets/AssetUploadSheet.tsx', /busy=\{running\}\s+disabled=\{!canUpload\}/],
    ['ui/ApproveConfirm.tsx', /data-approve-confirm-button=""[^>]*?busy=\{props\.busy\}/s],
    ['chat/ConceptSheet.tsx', /busy=\{busy && !waiting\}/],
  ];
  for (const [file, re] of SOURCE) {
    it(`${file}: primary is Button busy (${re.source.slice(0, 32)}…)`, () => {
      expect(read(`components/${file}`)).toMatch(re);
    });
  }

  it('no busy-label swaps left on these primaries', () => {
    expect(read('components/chat/NewChatSheet.tsx')).not.toMatch(/'Starting'|'Creating'/);
    expect(read('components/pages/pcs/PinAnnotationComposer.tsx')).not.toContain('Posting…');
    expect(read('components/pages/pcs/CaptionAnnotationComposer.tsx')).not.toContain('Posting…');
    expect(read('components/pages/pcs/PostDetailsSheet.tsx')).not.toContain("'Creating…'");
  });

  it('asset upload keeps its progress visible as a meta line in the footer', () => {
    const src = read('components/pages/assets/AssetUploadSheet.tsx');
    expect(src).toMatch(/data-upload-progress=""[^>]*textRole\('meta'/s);
  });
});

function tsx(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsx(p);
    return name.endsWith('.tsx') && !name.includes('.test.') ? [p] : [];
  });
}

// A file whose <Sheet ...> opening tag passes busy= must render a busy control
// (Button busy=, aria-busy on a row, or a part that does: ApproveConfirm,
// PlanOpenSendSheet, BankPlanItSheets).
describe('every <Sheet busy=...> has a busy control', () => {
  const DELEGATES = /<(ApproveConfirm|PlanOpenSendSheet|BankPlanItSheets)\b/;
  for (const full of tsx(join(ROOT, 'components'))) {
    const rel = relative(join(ROOT, 'components'), full).split(sep).join('/');
    if (rel.startsWith('ui/Sheet') || rel.includes('__tests__')) continue;
    const src = readFileSync(full, 'utf8');
    // The Sheet's own busy prop: no other JSX tag opens between <Sheet and busy=.
    const sheets = [...src.matchAll(/<Sheet\b([^>]|=>)*?\bbusy=\{/g)].filter(
      (m) => !m[0].slice(1).includes('<'),
    );
    if (sheets.length === 0) continue;
    it(rel, () => {
      // Every busy={...} beyond the Sheet's own is a control's (Button busy).
      const all = (src.match(/[\s{]busy=\{/g) ?? []).length;
      const hasBusyControl = all > sheets.length || /aria-busy=\{/.test(src) || DELEGATES.test(src);
      expect(hasBusyControl).toBe(true);
    });
  }
});

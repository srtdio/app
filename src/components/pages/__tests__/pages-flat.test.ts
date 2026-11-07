import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guard: the flat look (7 Nov 2026) on the page and sheet bodies. In-content
// surfaces are flat: no hand-built card frame (border + panel fill +
// lit-card / lit-card-muted), groups of rows split by --border hairlines, no
// dashed "add" box, no grey bg-bg well inside a sheet. Sheets themselves stay
// lit (ui/Sheet), and media, fields and floating layers are untouched.
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const FILES = [
  'CreatePostSheet.tsx',
  'HelpPage.tsx',
  'NotificationsPage.tsx',
  'PlanPage.tsx',
  'PostDetailPage.tsx',
  'RecentlyDeletedPage.tsx',
  'assets/AssetUploadSheet.tsx',
  'create/AttachmentsField.tsx',
  'pcs/PostDetailsSheet.tsx',
  'pcs/PostGallery.tsx',
  'pcs/PostReadyNotice.tsx',
  'pcs/ReadOnlyVersionView.tsx',
  'pipeline/MoveSheet.tsx',
  'plan-tab/BankAddSheet.tsx',
  'plan-tab/BankFilterSheet.tsx',
  'plan-tab/BankList.tsx',
  'plan-tab/BankPickSheet.tsx',
  'settings/MembersInviteForm.tsx',
] as const;

describe('pages: flat in-content surfaces', () => {
  for (const rel of FILES) {
    it(`${rel}: no lit-card frame, dashed box or grey sheet well`, () => {
      const src = read(rel);
      expect(src).not.toMatch(/\blit-card(-muted)?\b/);
      expect(src).not.toContain('border-dashed');
      expect(src).not.toContain('rounded-xl border bg-panel');
      expect(src).not.toContain('bg-bg p-4');
    });
  }

  it('the Bank sheets split their sections by hairlines; the Add sheet uses no Card', () => {
    expect(read('plan-tab/BankFilterSheet.tsx')).toContain('divide-y divide-border');
    const add = read('plan-tab/BankAddSheet.tsx');
    expect(add).toContain('divide-y divide-border');
    expect(add).not.toContain("from '@/components/ui/Card'");
  });

  it('From bank rows are flat edge-to-edge rows (single and multi pick share them)', () => {
    const pick = read('plan-tab/BankPickSheet.tsx');
    expect(pick).toContain(
      'className="flex items-center gap-3 border-b border-border px-4 py-3 text-left"',
    );
    expect(pick).toContain('multi.onToggle(idea)');
    expect(pick).toContain('<SelectCheck checked={multi.selected.has(idea.id)} />');
  });

  it('Add more files is a plain + row, not a dashed button', () => {
    const sheet = read('assets/AssetUploadSheet.tsx');
    expect(sheet).toMatch(/<PressableRow[\s\S]{0,400}?Add more files/);
  });
});

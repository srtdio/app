import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// The screens' import graph pulls the real agora-chat browser SDK; mock it so
// importing in node never touches browser globals (mirrors PlanCard.test.tsx).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
// The library picker reads the workspace; it is closed here, so stub it.
vi.mock('@/components/chat/AssetPicker', () => ({ AssetPicker: () => null }));
// The Sheet portals into document.body; render it in place for static markup.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (node: ReactNode) => node,
}));

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConceptSheet } from '@/components/chat/ConceptSheet';
import {
  DATE_FIELD,
  DATE_FIT,
  DraftConceptRow,
  draftConceptForm,
  removeDraftConcept,
  replaceDraftConcept,
  type DraftConceptItem,
} from '@/components/chat/PlanComposeScreen';
import { ToastProvider } from '@/components/ui/toast';

vi.stubGlobal('document', { body: {} });

const dir = fileURLToPath(new URL('..', import.meta.url));
const src = readFileSync(`${dir}PlanComposeScreen.tsx`, 'utf8');

const A: DraftConceptItem = {
  key: 'k1',
  title: 'Reel',
  description: 'Morning light',
  date: '2026-10-14',
  files: [
    { versionId: 'lib-1', name: 'cover.jpg' },
    { versionId: 'up-1', name: 'clip.mp4' },
  ],
};
const B: DraftConceptItem = { key: 'k2', title: 'Story', description: '', date: '', files: [] };
const C: DraftConceptItem = { key: 'k3', title: 'Carousel', description: '', date: '', files: [] };

const row = (locked: boolean): string =>
  renderToStaticMarkup(
    <DraftConceptRow concept={A} locked={locked} onEdit={() => {}} onRemove={() => {}} />,
  );

describe('draft concept: tap to edit (E1)', () => {
  it('the row (but the X) is one 44px+ button, no chevron, no iOS selection/callout', () => {
    const html = row(false);
    const edit = html.slice(html.indexOf('data-plan-draft-concept-edit'));
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(edit).toContain('aria-label="Edit Reel"');
    expect(edit).toContain('min-h-[44px]');
    expect(edit).toContain('select-none');
    expect(edit).toContain('[-webkit-touch-callout:none]');
    expect(html).not.toMatch(/chevron/i);
    const x = html.slice(html.indexOf('data-plan-draft-concept-remove'));
    expect(x).toContain('h-11 w-11');
    expect(x).toContain('aria-label="Remove Reel"');
  });

  it('tap opens the sheet prefilled with title, description, date and every file', () => {
    expect(draftConceptForm([A, B], 'k1')).toEqual({
      title: 'Reel',
      description: 'Morning light',
      date: '2026-10-14',
      files: A.files,
    });
    expect(draftConceptForm([A], 'gone')).toBeNull();
    expect(src).toMatch(
      /const editConcept = \(key: string\): void => \{\s*if \(locked\) return;[\s\S]*?setConceptForm\(form\);\s*setEditKey\(key\);\s*setConceptOpen\(true\);/,
    );
    const form = draftConceptForm([A], 'k1');
    if (form === null) throw new Error('no form');
    const html = renderToStaticMarkup(
      <ToastProvider>
        <ConceptSheet
          open
          mode="edit"
          form={form}
          onChange={() => {}}
          onSubmit={() => {}}
          onClose={() => {}}
        />
      </ToastProvider>,
    );
    expect(html).toContain('Edit concept');
    expect(html).toContain('value="Reel"');
    expect(html).toContain('Morning light');
    expect(html).toContain('value="2026-10-14"');
    expect(html.match(/data-plan-concept-file=""/g)).toHaveLength(2);
    expect(html).toMatch(/data-plan-concept-save=""[^>]*>Save</);
    expect(html).not.toContain('data-plan-concept-reset');
  });

  it('Save replaces in place: same key, same position, others untouched', () => {
    const next = replaceDraftConcept([A, B, C], 'k2', {
      title: 'Story v2',
      description: 'New',
      date: '2026-10-15',
      files: [{ versionId: 'up-2', name: 'a.png' }],
    });
    expect(next.map((c) => c.key)).toEqual(['k1', 'k2', 'k3']);
    expect(next[1]).toEqual({
      key: 'k2',
      title: 'Story v2',
      description: 'New',
      date: '2026-10-15',
      files: [{ versionId: 'up-2', name: 'a.png' }],
    });
    expect(next[0]).toBe(A);
    expect(next[2]).toBe(C);
  });

  it('the submit edits in place when a key is set, adds otherwise; no RPC', () => {
    const submit = src.slice(src.indexOf('const submitConcept'), src.indexOf('const editConcept'));
    expect(submit).toContain('replaceDraftConcept(prev, editKey, form)');
    expect(submit).not.toMatch(/plan\w*\(supabase/);
    expect(src).toContain("mode={editKey !== null ? 'edit' : 'add'}");
  });

  it('Cancel leaves the list as it was', () => {
    expect(src).toMatch(/onClose=\{\(\) => setConceptOpen\(false\)\}/);
    // Closing touches only the sheet: the list changes on submit or remove only.
    expect(src.match(/setConcepts\(/g)).toHaveLength(3);
  });

  it('X still removes', () => {
    expect(removeDraftConcept([A, B, C], 'k2').map((c) => c.key)).toEqual(['k1', 'k3']);
    expect(src).toContain(
      'onRemove={() => setConcepts((prev) => removeDraftConcept(prev, c.key))}',
    );
  });

  it('a locked screen disables both the row and the X', () => {
    const html = row(true);
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    expect(row(false)).not.toContain('disabled=""');
    expect(src).toContain('locked={locked}');
  });
});

describe('From / To fit the screen (E4)', () => {
  it('label and input can shrink; WebKit date look reset; 44px+, tokens only', () => {
    expect(src).toContain('className="flex w-full min-w-0 flex-col gap-1"');
    expect(src).toContain('className={DATE_FIELD}');
    expect(DATE_FIELD).toContain(DATE_FIT);
    expect(DATE_FIELD).toContain(' px-2.5 ');
    expect(DATE_FIELD).not.toContain('px-3.5');
    expect(DATE_FIELD).toContain('min-h-[48px]');
    expect(DATE_FIT).toContain('min-w-0');
    expect(DATE_FIT).toContain('appearance-none');
    expect(DATE_FIT).toContain('[-webkit-appearance:none]');
  });

  it('no em-dashes', () => {
    expect(src).not.toContain(String.fromCharCode(0x2014));
  });
});

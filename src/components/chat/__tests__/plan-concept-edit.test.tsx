import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// The screens' import graph pulls the real agora-chat browser SDK; mock it so
// importing in node never touches browser globals (mirrors PlanCard.test.tsx).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { conceptFormValid } from '@/components/chat/ConceptSheet';
import {
  CONCEPT_EDIT_RESET_HINT,
  CONCEPT_SAVE_FAILED,
  CONCEPT_UPDATED,
  canEditConcept,
  conceptEditForm,
  conceptEditResets,
} from '@/components/chat/PlanItemScreen';
import { conceptEditArgs, conceptEditUnchanged, type ConceptEdit } from '@/lib/chat/plans';

const item = {
  title: 'Reel',
  description: 'Morning light',
  target_date: '2026-10-14',
};
const same: ConceptEdit = {
  title: 'Reel',
  description: 'Morning light',
  targetDate: '2026-10-14',
  currentFiles: ['v1', 'v2'],
  pickedFiles: ['v1', 'v2'],
};
const dir = fileURLToPath(new URL('..', import.meta.url));
const read = (name: string): string => readFileSync(`${dir}${name}`, 'utf8');

describe('Edit concept (E1)', () => {
  it('only the agency edits, and only a concept; a client never does', () => {
    expect(canEditConcept('agency', { kind: 'concept' })).toBe(true);
    expect(canEditConcept('agency', { kind: 'post' })).toBe(false);
    expect(canEditConcept('client', { kind: 'concept' })).toBe(false);
    expect(canEditConcept('client', { kind: 'post' })).toBe(false);
    expect(canEditConcept('unknown', { kind: 'concept' })).toBe(false);
  });

  it('both Edit buttons and the sheet are gated by the same check', () => {
    const src = read('PlanItemScreen.tsx');
    expect(src.match(/data-plan-edit-concept=""/g)).toHaveLength(1);
    expect(src).toMatch(/\{editable \? \(\s*<Button[\s\S]*?data-plan-edit-concept=""/);
    expect(src).toMatch(/\{editable \? \(\s*<Button[\s\S]*?data-plan-edit-date=""/);
    expect(src).toMatch(/\{editable \? \(\s*<ConceptSheet/);
  });

  it('the Date row Edit ends on the box edge (-mr-2), like the Waiting chip', () => {
    const src = read('PlanItemScreen.tsx');
    expect(src).toMatch(/data-plan-edit-date=""[\s\S]*?className="-mr-2"/);
  });
});

describe('one concept sheet (E2, E5)', () => {
  it('Add and Edit render the same extracted component; no second sheet', () => {
    const compose = read('PlanComposeScreen.tsx');
    const itemSrc = read('PlanItemScreen.tsx');
    expect(compose).toContain('<ConceptSheet');
    expect(compose).toContain("mode={editKey !== null ? 'edit' : 'add'}");
    expect(itemSrc).toContain('<ConceptSheet');
    expect(itemSrc).toContain('mode="edit"');
    expect(compose).not.toContain('<Sheet');
    expect(itemSrc).not.toContain('<Sheet');
    expect(read('ConceptSheet.tsx')).toContain("edit ? 'Edit concept' : 'Add concept'");
  });

  it('prefills title, description, date and files', () => {
    // D1: the files carry their asset names (never "File 1"); a nameless one reads "Concept file".
    expect(
      conceptEditForm(item, [
        { versionId: 'v1', name: 'Hero shot.jpg', mimeType: 'image/jpeg', kind: 'image' },
        { versionId: 'v2', name: '', mimeType: 'application/pdf', kind: 'document' },
      ]),
    ).toEqual({
      title: 'Reel',
      description: 'Morning light',
      date: '2026-10-14',
      files: [
        { versionId: 'v1', name: 'Hero shot.jpg' },
        { versionId: 'v2', name: 'Concept file' },
      ],
    });
    expect(conceptEditForm({ title: null, description: null, target_date: null }, null)).toEqual({
      title: '',
      description: '',
      date: '',
      files: [],
    });
  });

  it('title is required (1 to 200 characters)', () => {
    expect(conceptFormValid({ title: '  ' })).toBe(false);
    expect(conceptFormValid({ title: 'a' })).toBe(true);
    expect(conceptFormValid({ title: 'a'.repeat(200) })).toBe(true);
    expect(conceptFormValid({ title: 'a'.repeat(201) })).toBe(false);
  });
});

describe('reset line (E3)', () => {
  it('shows only when the agency or client review is not waiting', () => {
    expect(conceptEditResets('waiting', 'waiting')).toBe(false);
    expect(conceptEditResets('approved', 'waiting')).toBe(true);
    expect(conceptEditResets('waiting', 'changes')).toBe(true);
    expect(conceptEditResets('approved', 'approved')).toBe(true);
    expect(CONCEPT_EDIT_RESET_HINT).toBe(
      'Saving sends this back to waiting for creators and approvers.',
    );
  });
});

describe('save (E4, E6)', () => {
  it('sends the full title, description and date every time', () => {
    const args = conceptEditArgs('i1', { ...same, title: 'Reel v2' }, 't');
    expect(args).toEqual({
      p_item_id: 'i1',
      p_title: 'Reel v2',
      p_description: 'Morning light',
      p_target_date: '2026-10-14',
      p_attachment_version_ids: null,
      p_trace_id: 't',
    });
  });

  it('files go as null when unchanged, an array when changed', () => {
    expect(conceptEditArgs('i1', same, 't').p_attachment_version_ids).toBeNull();
    expect(
      conceptEditArgs('i1', { ...same, currentFiles: null, pickedFiles: null }, 't')
        .p_attachment_version_ids,
    ).toBeNull();
    expect(
      conceptEditArgs('i1', { ...same, pickedFiles: ['v1'] }, 't').p_attachment_version_ids,
    ).toEqual(['v1']);
    expect(
      conceptEditArgs('i1', { ...same, pickedFiles: ['v1', 'v2', 'v3'] }, 't')
        .p_attachment_version_ids,
    ).toEqual(['v1', 'v2', 'v3']);
  });

  it('an unchanged form sends nothing', () => {
    expect(conceptEditUnchanged(item, same)).toBe(true);
    expect(conceptEditUnchanged(item, { ...same, currentFiles: null, pickedFiles: null })).toBe(
      true,
    );
    expect(
      conceptEditUnchanged(
        { title: 'Reel', description: null, target_date: null },
        { ...same, description: '', targetDate: null },
      ),
    ).toBe(true);
    expect(conceptEditUnchanged(item, { ...same, title: 'Reel v2' })).toBe(false);
    expect(conceptEditUnchanged(item, { ...same, description: '' })).toBe(false);
    expect(conceptEditUnchanged(item, { ...same, targetDate: null })).toBe(false);
    expect(conceptEditUnchanged(item, { ...same, targetDate: '2026-10-15' })).toBe(false);
    expect(conceptEditUnchanged(item, { ...same, pickedFiles: ['v2', 'v1'] })).toBe(false);
  });

  it('a save in flight never closes the sheet (Escape, backdrop, X)', () => {
    const src = read('PlanItemScreen.tsx');
    expect(src).toMatch(/onClose=\{\(\) => \{[\s\S]*?if \(!editBusy\) setEditOpen\(false\);/);
  });

  it('the save path returns early on an unchanged form, before any RPC', () => {
    const src = read('PlanItemScreen.tsx');
    const save = src.slice(src.indexOf('const saveEdit'), src.indexOf('const shown'));
    expect(save.indexOf('conceptEditUnchanged(')).toBeGreaterThan(-1);
    expect(save.indexOf('conceptEditUnchanged(')).toBeLessThan(save.indexOf('planConceptEdit('));
    expect(save.match(/planConceptEdit\(/g)).toHaveLength(1);
  });

  it('toast copy, no em-dashes', () => {
    expect(CONCEPT_UPDATED).toBe('Concept updated');
    expect(CONCEPT_SAVE_FAILED).toBe("Couldn't save. Try again.");
    for (const name of ['ConceptSheet.tsx', 'PlanItemScreen.tsx', 'PlanComposeScreen.tsx']) {
      expect(read(name)).not.toContain(String.fromCharCode(0x2014));
    }
  });
});

describe('Edit concept sheet file names (U9)', () => {
  it('each file tile shows its name under it (truncated, meta style) with the full name on hover', () => {
    const sheet = read('ConceptSheet.tsx');
    expect(sheet).toMatch(
      /data-plan-concept-file=""\s+title=\{f\.name\}[\s\S]*?data-plan-concept-file-name=""\s+className="block truncate text-sm text-fg-3"\s*>\s*\{f\.name\}/,
    );
    // The names come from the read (D1), never "File N".
    expect(read('PlanItemScreen.tsx')).not.toContain('`File ${');
  });
});

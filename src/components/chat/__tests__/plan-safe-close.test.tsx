import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// The screens' import graph pulls the real agora-chat browser SDK; mock it so
// importing in node never touches browser globals (mirrors PlanCard.test.tsx).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/components/chat/AssetPicker', () => ({ AssetPicker: () => null }));

import {
  CONCEPT_DISCARD_TITLE,
  EMPTY_CONCEPT,
  conceptDirty,
  conceptDiscardCopy,
} from '@/components/chat/ConceptSheet';
import { PLAN_DISCARD, composeHasContent } from '@/components/chat/PlanComposeScreen';

const dir = fileURLToPath(new URL('..', import.meta.url));
const composeSrc = readFileSync(`${dir}PlanComposeScreen.tsx`, 'utf8');
const conceptSrc = readFileSync(`${dir}ConceptSheet.tsx`, 'utf8');

describe('New plan safe close', () => {
  it('counts a name, an item or a concept draft as content', () => {
    expect(composeHasContent({ title: '', items: [], conceptDraft: EMPTY_CONCEPT })).toBe(false);
    expect(composeHasContent({ title: 'Week', items: [], conceptDraft: EMPTY_CONCEPT })).toBe(true);
    expect(composeHasContent({ title: '', items: [{}], conceptDraft: EMPTY_CONCEPT })).toBe(true);
    expect(
      composeHasContent({
        title: '',
        items: [],
        conceptDraft: { ...EMPTY_CONCEPT, title: 'Idea' },
      }),
    ).toBe(true);
  });

  it('closing with content opens the discard confirm with Keep editing', () => {
    expect(PLAN_DISCARD).toEqual({
      title: 'Discard this plan?',
      message: 'Your concepts and posts will be lost.',
    });
    expect(composeSrc).toContain('onBack={requestClose}');
    const dialog = composeSrc.slice(composeSrc.indexOf('<ConfirmDialog'));
    expect(dialog).toContain('cancelLabel="Keep editing"');
    expect(dialog).toContain('confirmLabel="Discard"');
    expect(dialog).toContain('destructive');
  });
});

describe('Concept sheet safe close', () => {
  it('is dirty with any Add content or an upload, and Edit only when changed', () => {
    const base = { mode: 'add' as const, baseline: EMPTY_CONCEPT, uploads: 0 };
    expect(conceptDirty({ ...base, form: EMPTY_CONCEPT })).toBe(false);
    expect(conceptDirty({ ...base, form: { ...EMPTY_CONCEPT, title: 'x' } })).toBe(true);
    expect(conceptDirty({ ...base, form: EMPTY_CONCEPT, uploads: 1 })).toBe(true);
    const was = { title: 'A', description: 'B', files: [], date: '' };
    expect(conceptDirty({ mode: 'edit', form: was, baseline: was, uploads: 0 })).toBe(false);
    expect(
      conceptDirty({ mode: 'edit', form: { ...was, title: 'A2' }, baseline: was, uploads: 0 }),
    ).toBe(true);
  });

  it('asks "Discard this concept?" and passes dirty to the Sheet', () => {
    expect(CONCEPT_DISCARD_TITLE).toBe('Discard this concept?');
    expect(conceptDiscardCopy('add').title).toBe('Discard this concept?');
    expect(conceptSrc).toContain('dirty={dirty}');
    expect(conceptSrc).toContain('discard={discardCopy}');
  });

  it('keeps an Add draft on reopen: Add concept resets only after an edit', () => {
    const add = composeSrc.slice(
      composeSrc.indexOf('data-plan-add-concept'),
      composeSrc.indexOf('Add concept\n'),
    );
    expect(add).toMatch(/if \(editKey !== null\) \{\s*setConceptForm\(EMPTY_CONCEPT\);/);
    expect(composeSrc).toContain('onClose={closeConcept}');
  });
});

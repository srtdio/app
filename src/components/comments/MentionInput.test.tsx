import { describe, expect, it } from 'vitest';
import { activeMentionQuery, serializeComposer } from '@/components/comments/MentionInput';

// The repo's vitest runs in the node environment (no jsdom), and the prompt
// scopes these tests to the two pure functions only: caret / selection behaviour
// is never exercised here. serializeComposer walks childNodes, so a minimal
// node-like shape (nodeType + nodeValue / dataset / textContent) is enough to
// drive it without a real DOM.

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function text(value: string): unknown {
  return { nodeType: TEXT_NODE, nodeValue: value };
}

function mention(id: string, name: string): unknown {
  return { nodeType: ELEMENT_NODE, dataset: { mentionId: id }, textContent: `@${name}` };
}

function plainElement(textContent: string): unknown {
  return { nodeType: ELEMENT_NODE, dataset: {}, textContent };
}

function root(children: unknown[]): HTMLElement {
  return { childNodes: children as unknown as NodeListOf<ChildNode> } as unknown as HTMLElement;
}

const ID = '11111111-2222-3333-4444-555555555555';

describe('serializeComposer', () => {
  it('returns plain text verbatim', () => {
    expect(serializeComposer(root([text('just a comment')]))).toBe('just a comment');
  });

  it('emits @[uuid] for a mention chip in document order', () => {
    expect(
      serializeComposer(root([text('hi '), mention(ID, 'Ann Lee'), text(' and others')])),
    ).toBe(`hi @[${ID}] and others`);
  });

  it('emits only the token for a chip, never the displayed name', () => {
    const out = serializeComposer(root([mention(ID, 'Ann Lee')]));
    expect(out).toBe(`@[${ID}]`);
    expect(out).not.toContain('Ann');
  });

  it('normalises non-breaking spaces in text nodes to plain spaces', () => {
    expect(serializeComposer(root([text('a b')]))).toBe('a b');
  });

  it('falls back to text content for a non-mention element', () => {
    expect(serializeComposer(root([plainElement('x')]))).toBe('x');
  });

  it('returns an empty string for an empty composer', () => {
    expect(serializeComposer(root([]))).toBe('');
  });
});

describe('activeMentionQuery', () => {
  it('opens with an empty query right after a bare trigger at the start', () => {
    expect(activeMentionQuery('@')).toBe('');
  });

  it('returns the run typed after a trigger at the start', () => {
    expect(activeMentionQuery('@an')).toBe('an');
  });

  it('opens after whitespace before the trigger', () => {
    expect(activeMentionQuery('hello @an')).toBe('an');
  });

  it('uses the last trigger when several are present', () => {
    expect(activeMentionQuery('@a @b')).toBe('b');
  });

  it('is case-insensitive only at the call site, returning the raw run', () => {
    expect(activeMentionQuery('@AnN')).toBe('AnN');
  });

  it('returns null when the trigger is not at a boundary (mid-word)', () => {
    expect(activeMentionQuery('email@domain')).toBeNull();
  });

  it('returns null when whitespace follows the trigger (run closed)', () => {
    expect(activeMentionQuery('@ann smith')).toBeNull();
  });

  it('returns null when there is no trigger', () => {
    expect(activeMentionQuery('no mention here')).toBeNull();
  });

  it('treats a non-breaking space as a boundary before the trigger', () => {
    expect(activeMentionQuery('hi @an')).toBe('an');
  });
});

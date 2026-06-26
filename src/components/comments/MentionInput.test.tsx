import { describe, expect, it } from 'vitest';
import type { MentionCandidate } from '@/components/comments/useMentionCandidates';
import {
  activeMentionQuery,
  buildInitialContent,
  serializeComposer,
} from '@/components/comments/MentionInput';

// The repo's vitest runs in the node environment (no jsdom), and the prompt
// scopes these tests to the two pure functions only: caret / selection behaviour
// is never exercised here. serializeComposer now walks the full subtree depth
// first, so a minimal node-like shape (nodeType + nodeValue, or tagName / dataset
// / nested childNodes for elements) is enough to drive it without a real DOM. A
// chip is just an element carrying dataset.mentionId.

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

function text(value: string): unknown {
  return { nodeType: TEXT_NODE, nodeValue: value };
}

function el(tagName: string, children: unknown[]): unknown {
  return { nodeType: ELEMENT_NODE, tagName, dataset: {}, childNodes: children };
}

// A mention chip: an element carrying a non-empty dataset.mentionId. Its display
// name lives only in the (omitted) child text; serializeComposer must never reach
// it, emitting @[id] and not descending.
function mention(id: string): unknown {
  return { nodeType: ELEMENT_NODE, tagName: 'SPAN', dataset: { mentionId: id }, childNodes: [] };
}

function br(): unknown {
  return { nodeType: ELEMENT_NODE, tagName: 'BR', dataset: {}, childNodes: [] };
}

// A plain inline element (a SPAN without a mention id) wrapping a single text run;
// serializeComposer descends into it and so contributes that text verbatim.
function plainElement(textContent: string): unknown {
  return el('SPAN', [text(textContent)]);
}

function root(children: unknown[]): HTMLElement {
  return { childNodes: children as unknown as NodeListOf<ChildNode> } as unknown as HTMLElement;
}

const ID = '11111111-2222-3333-4444-555555555555';
const ID2 = '66666666-7777-8888-9999-000000000000';

describe('serializeComposer', () => {
  it('returns plain text verbatim', () => {
    expect(serializeComposer(root([text('just a comment')]))).toBe('just a comment');
  });

  it('emits @[uuid] for a mention chip in document order', () => {
    expect(serializeComposer(root([text('hi '), mention(ID), text(' and others')]))).toBe(
      `hi @[${ID}] and others`,
    );
  });

  it('emits only the token for a chip, never the displayed name', () => {
    const out = serializeComposer(root([mention(ID)]));
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

  it('emits @[uuid] for a mention chip nested inside a block element', () => {
    const out = serializeComposer(root([el('DIV', [mention(ID)])]));
    expect(out).toBe(`@[${ID}]`);
    expect(out).not.toContain('Ann');
  });

  it('inserts a newline at a block boundary between two lines', () => {
    expect(serializeComposer(root([text('line1'), el('DIV', [text('line2')])]))).toBe(
      'line1\nline2',
    );
  });

  it('serializes a <br> between text runs as a newline', () => {
    expect(serializeComposer(root([text('a'), br(), text('b')]))).toBe('a\nb');
  });

  it('emits the token for a mention on a second block line', () => {
    expect(serializeComposer(root([text('hi '), el('DIV', [text('see '), mention(ID2)])]))).toBe(
      `hi \nsee @[${ID2}]`,
    );
  });
});

// buildInitialContent builds real DOM nodes via document; the node test env has
// no jsdom, so we drive it with a fake factory whose nodes share the minimal
// shape serializeComposer reads (nodeType / nodeValue, or tagName / dataset /
// childNodes). This exercises the seeding logic without mounting the component.
function fakeFactory(): Parameters<typeof buildInitialContent>[2] {
  return {
    createElement(): HTMLElement {
      return {
        nodeType: ELEMENT_NODE,
        tagName: 'SPAN',
        dataset: {},
        className: '',
        textContent: '',
        childNodes: [],
        setAttribute() {},
      } as unknown as HTMLElement;
    },
    createTextNode(value: string): Text {
      return { nodeType: TEXT_NODE, nodeValue: value } as unknown as Text;
    },
  };
}

function mentionId(node: unknown): string | undefined {
  return (node as { dataset?: { mentionId?: string } }).dataset?.mentionId;
}

describe('buildInitialContent (reply seed)', () => {
  const members: MentionCandidate[] = [{ id: ID, name: 'Ann', role: '', avatarUrl: null }];

  it('builds one mention chip for a seeded token and serializes back to the token', () => {
    const nodes = buildInitialContent(`@[${ID}] `, members, fakeFactory());
    const chips = nodes.filter((node) => mentionId(node) === ID);
    expect(chips).toHaveLength(1);
    expect(serializeComposer(root(nodes as unknown[]))).toBe(`@[${ID}] `);
  });

  it('seeds nothing for an empty body (editor mounts blank, no mention)', () => {
    const nodes = buildInitialContent('', members, fakeFactory());
    expect(nodes).toHaveLength(0);
    expect(nodes.some((node) => mentionId(node) !== undefined)).toBe(false);
    expect(serializeComposer(root([]))).toBe('');
  });

  it('keeps an unresolved token as literal text, never dropping it', () => {
    const nodes = buildInitialContent(`@[${ID2}] hi`, members, fakeFactory());
    expect(nodes.some((node) => mentionId(node) !== undefined)).toBe(false);
    expect(serializeComposer(root(nodes as unknown[]))).toBe(`@[${ID2}] hi`);
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

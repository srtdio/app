import { describe, expect, it } from 'vitest';
import type { MentionCandidate } from '@/components/comments/useMentionCandidates';
import {
  activeMentionQuery,
  buildInitialContent,
  insertTextAtPoint,
  serializeComposer,
} from '@/components/comments/MentionInput';
import type { CaretPoint } from '@/components/comments/MentionInput';

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

// insertTextAtPoint runs against a tiny live tree (parentNode + insertBefore),
// the slice of the DOM it touches; the Range / selection plumbing around it is
// browser-only.
class LiveNode {
  parentNode: LiveNode | null = null;
  childNodes: LiveNode[] = [];
  constructor(
    public nodeType: number,
    public nodeValue: string | null,
    public tagName = '',
    public dataset: Record<string, string> = {},
  ) {}
  insertBefore(node: LiveNode, ref: LiveNode | null): LiveNode {
    node.parentNode = this;
    const at = ref === null ? this.childNodes.length : this.childNodes.indexOf(ref);
    this.childNodes.splice(at, 0, node);
    return node;
  }
}

function liveText(value: string): LiveNode {
  return new LiveNode(TEXT_NODE, value);
}

function liveEl(tagName: string, children: LiveNode[], dataset: Record<string, string> = {}) {
  const node = new LiveNode(ELEMENT_NODE, null, tagName, dataset);
  for (const child of children) node.insertBefore(child, null);
  return node;
}

const liveFactory = { createTextNode: (data: string) => liveText(data) as unknown as Text };

function insert(rootNode: LiveNode, point: CaretPoint | null, value: string): CaretPoint {
  return insertTextAtPoint(rootNode as unknown as HTMLElement, point, value, liveFactory);
}

function at(node: LiveNode, offset: number): CaretPoint {
  return { node: node as unknown as Node, offset };
}

function body(rootNode: LiveNode): string {
  return serializeComposer(rootNode as unknown as HTMLElement);
}

describe('insertTextAtPoint (laptop emoji insert)', () => {
  function draft(): { editor: LiveNode; chip: LiveNode; tail: LiveNode } {
    const chip = liveEl('SPAN', [liveText('@Ana')], { mentionId: ID });
    const tail = liveText(' there');
    const editor = liveEl('DIV', [liveText('Hi '), chip, tail]);
    return { editor, chip, tail };
  }

  it('inserts at the saved caret mid-text and keeps the @mention chip token', () => {
    const { editor, chip, tail } = draft();
    insert(editor, at(tail, 1), '😀');
    expect(body(editor)).toBe(`Hi @[${ID}] 😀there`);
    expect(editor.childNodes).toContain(chip);
  });

  it('two picks in a row insert both, in order', () => {
    const { editor, tail } = draft();
    const caret = insert(editor, at(tail, 1), '😀');
    insert(editor, caret, '🎉');
    expect(body(editor)).toBe(`Hi @[${ID}] 😀🎉there`);
  });

  it('a caret between children inserts a new text node there', () => {
    const { editor } = draft();
    const caret = insert(editor, at(editor, 1), '👍');
    expect(body(editor)).toBe(`Hi 👍@[${ID}] there`);
    insert(editor, caret, '!');
    expect(body(editor)).toBe(`Hi 👍!@[${ID}] there`);
  });

  it('a caret inside a chip moves after it: the chip is never split', () => {
    const { editor, chip } = draft();
    const chipText = chip.childNodes[0] as LiveNode;
    insert(editor, at(chipText, 2), '😀');
    expect(body(editor)).toBe(`Hi @[${ID}]😀 there`);
    expect(chipText.nodeValue).toBe('@Ana');
  });

  it('no saved caret, or one outside the editor, inserts at the end', () => {
    const { editor } = draft();
    insert(editor, null, '😀');
    expect(body(editor)).toBe(`Hi @[${ID}] there😀`);
    const elsewhere = liveText('outside');
    insert(editor, at(elsewhere, 3), '🎉');
    expect(body(editor)).toBe(`Hi @[${ID}] there😀🎉`);
    expect(elsewhere.nodeValue).toBe('outside');
  });

  it('the end is before a trailing placeholder <br>', () => {
    const editor = liveEl('DIV', [liveText('ok'), liveEl('BR', [])]);
    insert(editor, null, '😀');
    expect(body(editor)).toBe('ok😀\n');
  });

  it('an empty editor takes the emoji as its only text', () => {
    const editor = liveEl('DIV', []);
    insert(editor, null, '😀');
    expect(body(editor)).toBe('😀');
  });
});

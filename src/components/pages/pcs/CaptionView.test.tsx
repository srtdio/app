import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  captionView,
  captionSpanFromSelection,
  selectionToAnnotation,
  CAPTION_MARKER_ATTR,
  type SelectionLike,
} from '@/components/pages/pcs/CaptionView';

// The unit environment is node (no DOM renderer), so these specs walk the JSX
// tree returned by the hookless captionView and exercise the offset math with
// hand-built node stubs, mirroring the gallery view test style.

function flatten(node: ReactNode, out: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => flatten(child, out));
    return;
  }
  if (node === null || typeof node !== 'object' || !('props' in node)) return;
  const el = node as ReactElement;
  out.push(el);
  flatten((el.props as { children?: ReactNode }).children, out);
}

function elements(tree: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  flatten(tree, out);
  return out;
}

// Minimal DOM stubs: only the members captionOffset reads (nodeType, nodeValue,
// childNodes, getAttribute). Cast through unknown because these are not real
// DOM Nodes, only the shape the walker touches.
function textNode(value: string): Node {
  return { nodeType: 3, nodeValue: value, childNodes: [] } as unknown as Node;
}
function elementNode(children: Node[], marker = false): Node {
  return {
    nodeType: 1,
    nodeValue: null,
    childNodes: children,
    getAttribute: (name: string) => (marker && name === CAPTION_MARKER_ATTR ? '' : null),
  } as unknown as Node;
}

describe('captionView', () => {
  it('renders a highlight and an unselectable superscript for an in-bounds annotation', () => {
    const tree = captionView({
      caption: 'Hello world',
      annotations: [{ id: 'a1', n: 1, captionStart: 0, captionEnd: 5, commentId: 'c1' }],
      onHighlightClick: () => {},
    });
    const all = elements(tree);

    const marks = all.filter((el) => el.type === 'mark');
    expect(marks.length).toBe(1);

    const sup = all.find((el) => el.type === 'sup');
    expect(sup).toBeDefined();
    expect((sup!.props as Record<string, unknown>)[CAPTION_MARKER_ATTR]).toBe('');
    expect((sup!.props as { children?: ReactNode }).children).toBe(1);
    // The number marker opts out of selection so offset math can skip it.
    expect((sup!.props as { className?: string }).className).toContain('select-none');
  });

  it('skips an out-of-bounds annotation without throwing or emitting a mark', () => {
    const render = () =>
      captionView({
        caption: 'Hi',
        annotations: [{ id: 'a', n: 1, captionStart: 0, captionEnd: 99, commentId: 'c' }],
        onHighlightClick: () => {},
      });
    expect(render).not.toThrow();
    expect(elements(render()).some((el) => el.type === 'mark')).toBe(false);
  });

  it('clicking a mark calls onHighlightClick with that comment id', () => {
    const onHighlightClick = vi.fn();
    const tree = captionView({
      caption: 'Hello world',
      annotations: [{ id: 'a1', n: 1, captionStart: 6, captionEnd: 11, commentId: 'c-42' }],
      onHighlightClick,
    });
    const mark = elements(tree).find((el) => el.type === 'mark')!;
    (mark.props as { onClick: () => void }).onClick();
    expect(onHighlightClick).toHaveBeenCalledWith('c-42');
  });
});

describe('caption selection offsets', () => {
  // Structure mirrors a rendered caption "abcdef": text "ab", a mark holding
  // "cd" plus a superscript marker "1", then text "ef". Walking by node order
  // must exclude the marker's "1", so abcdef stays length 6, not 7.
  function buildRoot(): { root: Node; ab: Node; ef: Node; sup: Node } {
    const ab = textNode('ab');
    const cd = textNode('cd');
    const supText = textNode('1');
    const sup = elementNode([supText], true);
    const mark = elementNode([cd, sup]);
    const ef = textNode('ef');
    const root = elementNode([ab, mark, ef]);
    return { root, ab, ef, sup };
  }

  it('computes start/end by node walking, excluding the superscript marker', () => {
    const { root, ab, ef } = buildRoot();
    const selection: SelectionLike = {
      anchorNode: ab,
      anchorOffset: 1,
      focusNode: ef,
      focusOffset: 1,
      isCollapsed: false,
    };
    expect(captionSpanFromSelection(root, selection, 6)).toEqual({ start: 1, end: 5 });
    expect(selectionToAnnotation(root, selection, 'abcdef')).toEqual({
      start: 1,
      end: 5,
      quote: 'bcde',
    });
  });

  it('ignores a collapsed selection and one landing inside the marker', () => {
    const { root, ab, sup } = buildRoot();
    expect(
      captionSpanFromSelection(
        root,
        { anchorNode: ab, anchorOffset: 1, focusNode: ab, focusOffset: 1, isCollapsed: true },
        6,
      ),
    ).toBeNull();
    expect(
      captionSpanFromSelection(
        root,
        { anchorNode: sup, anchorOffset: 0, focusNode: sup, focusOffset: 1, isCollapsed: false },
        6,
      ),
    ).toBeNull();
  });
});

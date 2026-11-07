import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  framePins,
  galleryToolsRow,
  pinButton,
  type GalleryToolsModel,
} from '@/components/pages/pcs/PostGallery';
import { IDENTITY_MAP, type PinDot } from '@/components/pages/pcs/pin-annotations';
import { CheckpointCircle } from '@/components/comments/CheckpointCircle';
import { IconButton } from '@/components/ui/IconButton';

// Photo pins and the photo toolbar: the pin marker is the checkpoint circle
// (resolved pins go good like the list, an agency pin is the ink dot), and the
// client's toolbar is Add pin only while the agency keeps Add, Replace, Add pin
// and v{n}. node environment, no DOM: hookless trees are walked.

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

function toolsModel(over: Partial<GalleryToolsModel> = {}): GalleryToolsModel {
  return {
    canEdit: true,
    itemCount: 3,
    versionNumber: 4,
    saving: false,
    error: null,
    onAdd: vi.fn(),
    onReplace: vi.fn(),
    onReorder: vi.fn(),
    onVersions: vi.fn(),
    ...over,
  };
}

const DOT = (over: Partial<PinDot>): PinDot => ({
  n: 1,
  state: 'open',
  annotationId: 'a1',
  commentId: 'c1',
  x: 0.5,
  y: 0.5,
  ...over,
});

describe('photo toolbar', () => {
  it('the client toolbar shows only Add pin', () => {
    const pin = pinButton(0, null, vi.fn(), vi.fn());
    const tree = galleryToolsRow(
      toolsModel({ canEdit: false, pinOnly: true, locked: true, versionNumber: 4, pin }),
    );
    expect(tree).not.toBeNull();
    const html = renderToStaticMarkup(tree!);
    expect(html).toContain('Add pin');
    expect(html).not.toContain('data-gallery-add');
    expect(html).not.toContain('data-gallery-replace');
    expect(html).not.toContain('data-gallery-reorder');
    expect(html).not.toContain('data-gallery-versions');
    expect(html).not.toContain('data-gallery-lock');
    expect(html.match(/min-h-11/g)?.length).toBe(1);
  });

  it('pinOnly wins even if the page passed canEdit', () => {
    const pin = pinButton(0, null, vi.fn(), vi.fn());
    const html = renderToStaticMarkup(
      galleryToolsRow(toolsModel({ canEdit: true, pinOnly: true, pin }))!,
    );
    expect(html).toContain('Add pin');
    expect(html).not.toContain('data-gallery-add');
    expect(html).not.toContain('>v4<');
  });

  it('a client with no pin on offer gets no row', () => {
    expect(galleryToolsRow(toolsModel({ canEdit: false, pinOnly: true }))).toBeNull();
  });

  it('the agency toolbar keeps Add, Replace, Add pin and v{n}', () => {
    const pin = pinButton(0, null, vi.fn(), vi.fn());
    const html = renderToStaticMarkup(galleryToolsRow(toolsModel({ pin }))!);
    for (const text of ['>Add<', '>Replace<', 'Add pin<', '>v4<']) expect(html).toContain(text);
  });
});

describe('photo pin markers', () => {
  function circles(pins: PinDot[]): { n?: number; state: string; size?: string }[] {
    return elements(framePins(pins, IDENTITY_MAP, () => {}))
      .filter((el) => el.type === CheckpointCircle)
      .map((el) => el.props as { n?: number; state: string; size?: string });
  }

  it('open, resolved and confirmed pins draw the checkpoint circle with their number', () => {
    expect(
      circles([
        DOT({ n: 1, state: 'open', annotationId: 'a' }),
        DOT({ n: 2, state: 'resolved', annotationId: 'b' }),
        DOT({ n: 3, state: 'confirmed', annotationId: 'c' }),
      ]),
    ).toEqual([
      { n: 1, state: 'open', size: 'marker' },
      { n: 2, state: 'resolved', size: 'marker' },
      { n: 3, state: 'confirmed', size: 'marker' },
    ]);
  });

  it('an agency pin is the ink dot with no number', () => {
    expect(circles([DOT({ n: null, state: 'pin' })])).toEqual([{ state: 'pin', size: 'marker' }]);
    const tree = framePins([DOT({ n: null, state: 'pin' })], IDENTITY_MAP, () => {});
    const button = elements(tree).find((el) => el.type === IconButton);
    expect((button?.props as { label: string }).label).toBe('Pin');
    expect((button?.props as Record<string, unknown>)['data-pin-state']).toBe('pin');
  });

  it('a pin cut off by the frame shows the small circle on the edge', () => {
    const cropped = { win: { x: 0.25, y: 0, w: 0.5, h: 1 }, box: IDENTITY_MAP.box };
    const tree = framePins([DOT({ n: 6, x: 0.05 })], cropped, () => {});
    const circle = elements(tree).find((el) => el.type === CheckpointCircle);
    expect(circle?.props).toEqual({ n: 6, state: 'open', size: 'inline' });
    const button = elements(tree).find((el) => el.type === IconButton);
    expect((button?.props as { label: string }).label).toBe('Pin 6, outside the frame');
  });

  it('no gold token on any marker', () => {
    for (const el of elements(framePins([DOT({})], IDENTITY_MAP, () => {}))) {
      expect(String((el.props as { className?: string }).className ?? '')).not.toContain(
        'annotation',
      );
    }
  });
});

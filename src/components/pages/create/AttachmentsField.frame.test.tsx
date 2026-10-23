// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/env', () => ({ env: { VITE_ASSET_UPLOAD_URL: 'https://upload.test' } }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => () => 'trace-1' }));

import { AttachmentsField, CREATE_FRAME_MAX_HEIGHT, type AttachmentItem } from './AttachmentsField';
import { frameBoxStyle } from '@/components/media/PlatformFrame';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function show(
  frame: { platform: string; format: string } | null,
  value: AttachmentItem[] = [],
): Promise<void> {
  await act(async () => {
    root!.render(
      <AttachmentsField workspaceId="ws-1" value={value} onChange={() => {}} frame={frame} />,
    );
  });
}

const frameEl = (): HTMLElement | null => document.querySelector('[data-frame-ratio]');
const ratio = (): number => Number(frameEl()?.getAttribute('data-frame-ratio'));

describe('AttachmentsField platform frame (standard composer)', () => {
  it('shows the empty frame at the format shape before any upload; tapping it opens the picker', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    await show({ platform: 'instagram', format: 'reel' });
    expect(frameEl()?.hasAttribute('data-frame-empty')).toBe(true);
    expect(ratio()).toBeCloseTo(9 / 16);
    const target = frameEl()!.querySelector('button')!;
    expect(target.className).toContain('inset-0');
    await act(async () => target.click());
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.contexts[0]).toHaveProperty('accept', expect.stringContaining('video/'));
    click.mockRestore();
  });

  it('re-shapes immediately on a format change, with or without media', async () => {
    await show({ platform: 'instagram', format: 'reel' });
    await show({ platform: 'instagram', format: 'single_image' });
    expect(ratio()).toBeCloseTo(4 / 5);
    const photo: AttachmentItem = {
      versionId: 'v',
      kind: 'image',
      name: 'p.png',
      previewUrl: 'blob:p',
      mime: 'image/png',
    };
    await show({ platform: 'instagram', format: 'single_image' }, [photo]);
    expect(frameEl()?.hasAttribute('data-frame-empty')).toBe(false);
    await show({ platform: 'instagram', format: 'story' }, [photo]);
    expect(ratio()).toBeCloseTo(9 / 16);
    expect(frameEl()?.style.width).toBe('min(100%, 33.75vh)');
  });

  it('no frame for a text post or a brief: no box', async () => {
    await show({ platform: 'linkedin', format: 'text' });
    expect(frameEl()).toBeNull();
    await show(null);
    expect(frameEl()).toBeNull();
  });

  it('A3: an X thread has no empty frame; a photo brings the frame', async () => {
    await show({ platform: 'x', format: 'thread' });
    expect(frameEl()).toBeNull();
    expect(document.querySelector('[data-frame-empty]')).toBeNull();
    const photo: AttachmentItem = {
      versionId: 't',
      kind: 'image',
      name: 't.png',
      previewUrl: 'blob:t',
      mime: 'image/png',
    };
    await show({ platform: 'x', format: 'thread' }, [photo]);
    expect(frameEl()).not.toBeNull();
    expect(frameEl()?.hasAttribute('data-frame-empty')).toBe(false);
  });

  it('YouTube Shorts frames a video 9:16 with bands, never cropped', async () => {
    const clip: AttachmentItem = {
      versionId: 'c',
      kind: 'file',
      name: 'c.mp4',
      previewUrl: 'blob:c',
      mime: 'video/mp4',
    };
    await show({ platform: 'youtube_shorts', format: 'short' }, [clip]);
    expect(ratio()).toBeCloseTo(9 / 16);
    expect(frameEl()?.getAttribute('data-frame-fit')).toBe('contain');
    expect(frameEl()?.className).toContain('bg-black');
    expect(frameEl()?.querySelector('video')?.className).toContain('object-contain');
  });
});

describe('AttachmentsField create dropzone', () => {
  const labels = (root: ParentNode): string[] =>
    [...root.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());

  it('Photo, Document and Link sit inside the empty frame, with no row below it', async () => {
    await show({ platform: 'instagram', format: 'single_image' });
    const zone = document.querySelector<HTMLElement>('[data-frame-empty] [data-dropzone]');
    expect(zone).not.toBeNull();
    expect(labels(zone!)).toEqual(['Photo', 'Document', 'Link']);
    // Nothing duplicated outside the frame.
    expect(labels(document.body)).toEqual(['Photo', 'Document', 'Link']);
  });

  it('the dropzone keeps the platform ratio under the create sheet cap', async () => {
    await show({ platform: 'instagram', format: 'single_image' });
    expect(CREATE_FRAME_MAX_HEIGHT).toBe('min(60vh, 440px)');
    expect(frameEl()?.getAttribute('data-frame-ratio')).not.toBeNull();
    // A 4:5 frame is never wider than 440px * 0.8, so never taller than 440px.
    expect(frameBoxStyle(0.8, CREATE_FRAME_MAX_HEIGHT).width).toBe(
      'min(100%, calc(min(60vh, 440px) * 0.8))',
    );
  });

  it('with media in the frame the add buttons are one row under it', async () => {
    const photo: AttachmentItem = {
      versionId: 'p',
      kind: 'image',
      name: 'p.png',
      previewUrl: 'blob:p',
      mime: 'image/png',
    };
    await show({ platform: 'instagram', format: 'single_image' }, [photo]);
    expect(document.querySelector('[data-dropzone]')).toBeNull();
    expect(labels(document.body).filter((l) => l === 'Photo')).toHaveLength(1);
  });
});

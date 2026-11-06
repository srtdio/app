import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  forwardPickedFile,
  photoOptions,
  PhotoOptionRows,
  runPhotoOption,
} from '@/components/ui/PhotoOptionsSheet';

// Node SSR, no DOM: the rows are pure markup and the input / row wiring is
// exercised through the exported helpers the component calls.

function visible(html: string): string {
  return html.replace(/<[^>]*>/g, '|');
}

describe('PhotoOptionsSheet rows', () => {
  it('shows Take photo, Choose from library and Remove photo when a photo is set', () => {
    expect(photoOptions(true)).toEqual(['camera', 'library', 'remove']);
    const out = visible(renderToStaticMarkup(<PhotoOptionRows hasPhoto onSelect={() => {}} />));
    expect(out).toContain('Take photo');
    expect(out).toContain('Choose from library');
    expect(out).toContain('Remove photo');
  });

  it('hides Remove photo when there is no photo', () => {
    expect(photoOptions(false)).toEqual(['camera', 'library']);
    const out = renderToStaticMarkup(<PhotoOptionRows hasPhoto={false} onSelect={() => {}} />);
    expect(out).toContain('Take photo');
    expect(out).toContain('Choose from library');
    expect(out).not.toContain('Remove photo');
  });

  it('uses tokens only: danger token on Remove, no hex or dark: literals, min-h-12 rows', () => {
    const out = renderToStaticMarkup(<PhotoOptionRows hasPhoto onSelect={() => {}} />);
    const remove = out.slice(out.indexOf('data-row="photo-remove"'));
    expect(remove).toContain('text-bad');
    expect(out).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(out).not.toContain('dark:');
    expect(out.match(/min-h-12/g)).toHaveLength(3);
    expect(out).toContain('pb-[env(safe-area-inset-bottom)]');
  });

  it('carries no user or group wording', () => {
    const out = renderToStaticMarkup(<PhotoOptionRows hasPhoto onSelect={() => {}} />);
    expect(out.toLowerCase()).not.toMatch(/\b(your|group|profile|user)\b/);
  });
});

describe('forwardPickedFile', () => {
  it('hands the picked file to onFile and clears the input', () => {
    const file = new File(['x'], 'me.png', { type: 'image/png' });
    const target = { files: [file], value: 'C:\\fakepath\\me.png' };
    const onFile = vi.fn();
    forwardPickedFile(target, onFile);
    expect(onFile).toHaveBeenCalledWith(file);
    expect(target.value).toBe('');
  });

  it('does nothing when the picker was cancelled', () => {
    const onFile = vi.fn();
    forwardPickedFile({ files: [], value: '' }, onFile);
    forwardPickedFile({ files: null, value: '' }, onFile);
    expect(onFile).not.toHaveBeenCalled();
  });
});

describe('runPhotoOption', () => {
  function actions() {
    return { close: vi.fn(), camera: vi.fn(), library: vi.fn(), remove: vi.fn() };
  }

  it('Remove closes the sheet and calls onRemove', () => {
    const a = actions();
    runPhotoOption('remove', a);
    expect(a.close).toHaveBeenCalledOnce();
    expect(a.remove).toHaveBeenCalledOnce();
    expect(a.camera).not.toHaveBeenCalled();
  });

  it('Take photo and Choose from library open their own input', () => {
    const a = actions();
    runPhotoOption('camera', a);
    runPhotoOption('library', a);
    expect(a.camera).toHaveBeenCalledOnce();
    expect(a.library).toHaveBeenCalledOnce();
    expect(a.remove).not.toHaveBeenCalled();
  });
});

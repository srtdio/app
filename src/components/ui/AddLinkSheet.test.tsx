// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AddLinkSheet, { ADD_LINK_ERROR, addLinkMarkup } from '@/components/ui/AddLinkSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function mount(initialText = '') {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <AddLinkSheet open initialText={initialText} onCancel={onCancel} onSave={onSave} />,
    );
    await wait(30);
  });
  return { onSave, onCancel };
}

const textField = () => document.querySelector<HTMLInputElement>('[data-add-link-text]')!;
const linkField = () => document.querySelector<HTMLInputElement>('[data-add-link-url]')!;
const saveButton = () => document.querySelector<HTMLButtonElement>('[data-add-link-save]')!;
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label);
const errorNote = () => document.querySelector('[role="alert"]');

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function save(): Promise<void> {
  await act(async () => saveButton().click());
}

describe('AddLinkSheet', () => {
  it('is titled "Add link" with Text and Link fields, Cancel and Save', async () => {
    await mount();
    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Add link');
    const labels = [...document.querySelectorAll('label')].map((l) => l.textContent);
    expect(labels).toEqual(['Text', 'Link']);
    expect(linkField().getAttribute('inputmode')).toBe('url');
    expect(button('Cancel')).toBeDefined();
    expect(saveButton().textContent).toBe('Save');
  });

  it('prefills Text with initialText and focuses Link', async () => {
    await mount('our brief');
    expect(textField().value).toBe('our brief');
    expect(linkField().value).toBe('');
    expect(document.activeElement).toBe(linkField());
  });

  it('focuses Text when there is no initial text', async () => {
    await mount('');
    expect(document.activeElement).toBe(textField());
  });

  it('a bare domain gets https:// and Save emits [text](url)', async () => {
    const { onSave } = await mount('Sorted');
    await type(linkField(), 'srtdio.com/brief');
    await save();
    expect(onSave).toHaveBeenCalledWith('[Sorted](https://srtdio.com/brief)');
  });

  it('Save emits [text](url) for a full https link', async () => {
    const { onSave } = await mount('');
    await type(textField(), 'Docs');
    await type(linkField(), 'https://example.com/a');
    await save();
    expect(onSave).toHaveBeenCalledWith('[Docs](https://example.com/a)');
  });

  it('javascript: is rejected: no save, the error shows only after a Save', async () => {
    const { onSave } = await mount('click me');
    await type(linkField(), 'javascript:alert(1)');
    expect(errorNote()).toBeNull();
    await save();
    expect(onSave).not.toHaveBeenCalled();
    expect(errorNote()?.textContent).toBe(ADD_LINK_ERROR);
    expect(linkField().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(linkField());
  });

  it('the error clears once the link is fixed', async () => {
    await mount('x');
    await save();
    expect(errorNote()).not.toBeNull();
    await type(linkField(), 'example.com');
    expect(errorNote()).toBeNull();
  });

  it('Enter in the Link field saves', async () => {
    const { onSave } = await mount('Site');
    await type(linkField(), 'example.com');
    await act(async () => {
      linkField().form?.requestSubmit();
    });
    expect(onSave).toHaveBeenCalledWith('[Site](https://example.com)');
  });

  it('Cancel calls onCancel and never saves', async () => {
    const { onSave, onCancel } = await mount('x');
    await act(async () => button('Cancel')?.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('addLinkMarkup: normalizes or refuses', () => {
    expect(addLinkMarkup('a', 'example.com')).toBe('[a](https://example.com)');
    expect(addLinkMarkup('a', 'javascript:alert(1)')).toBeNull();
    expect(addLinkMarkup('a', 'mailto:x@y.z')).toBeNull();
    expect(addLinkMarkup('', 'https://example.com')).toBe('[example.com](https://example.com)');
  });
});

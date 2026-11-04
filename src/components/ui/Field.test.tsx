// @vitest-environment jsdom
// Field links its label to the control: htmlFor (or id) when given, else a
// generated id handed to the control through the render prop.
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Field, fieldControlId } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function mount(node: ReactElement): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
}

describe('fieldControlId', () => {
  it('prefers htmlFor, then id, then the generated id', () => {
    expect(fieldControlId('a', 'b', 'g')).toBe('a');
    expect(fieldControlId(undefined, 'b', 'g')).toBe('b');
    expect(fieldControlId(undefined, undefined, 'g')).toBe('g');
  });
});

describe('Field', () => {
  it('generates an id and hands it to the control: the label names the input', () => {
    mount(<Field label="Search">{(id) => <Input id={id} value="" onChange={() => {}} />}</Field>);
    const label = document.querySelector('label');
    const input = document.querySelector('input');
    expect(input?.id).toBeTruthy();
    expect(label?.htmlFor).toBe(input?.id);
    expect(input?.labels?.[0]?.textContent).toBe('Search');
  });

  it('uses the given htmlFor for the label and the render prop', () => {
    mount(
      <Field label="Title" htmlFor="post-title">
        {(id) => <Input id={id} value="" onChange={() => {}} />}
      </Field>,
    );
    expect(document.querySelector('label')?.htmlFor).toBe('post-title');
    expect(document.querySelector('input')?.id).toBe('post-title');
  });

  it('two Fields never share a generated id', () => {
    mount(
      <>
        <Field label="A">{(id) => <Input id={id} value="" onChange={() => {}} />}</Field>
        <Field label="B">{(id) => <Input id={id} value="" onChange={() => {}} />}</Field>
      </>,
    );
    const [a, b] = Array.from(document.querySelectorAll('input'));
    expect(a?.id).not.toBe(b?.id);
  });

  it('a plain-node child with no id leaves the label unlinked (a group label)', () => {
    mount(
      <Field label="Attachments">
        <p>files</p>
      </Field>,
    );
    expect(document.querySelector('label')?.hasAttribute('for')).toBe(false);
  });
});

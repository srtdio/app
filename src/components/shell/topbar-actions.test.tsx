// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TopbarActionsProvider,
  TopbarPlus,
  useTopbarActions,
  useTopbarActionsValue,
} from '@/components/shell/topbar-actions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function Bar() {
  const a = useTopbarActionsValue();
  return (
    <header>
      <span data-probe="sort">{a.sort}</span>
      <span data-probe="primary">{a.primary}</span>
    </header>
  );
}

function Page({ label }: { label: string }) {
  useTopbarActions({ sort: <i>sort-{label}</i>, primary: <b>plus-{label}</b> });
  return <main>{label}</main>;
}

async function mount(page: ReactElement | null): Promise<void> {
  if (root === null) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => {
    root?.render(
      <TopbarActionsProvider>
        <Bar />
        {page}
      </TopbarActionsProvider>,
    );
  });
}

const probe = (name: string) => document.querySelector(`[data-probe="${name}"]`)?.textContent;

describe('topbar actions (decision A)', () => {
  it('a page publishes its sort and primary; the bar renders them', async () => {
    await mount(<Page label="pipeline" />);
    expect(probe('sort')).toBe('sort-pipeline');
    expect(probe('primary')).toBe('plus-pipeline');
  });

  it('switching pages swaps the actions; unmount clears them', async () => {
    await mount(<Page label="pipeline" />);
    await mount(<Page key="b" label="briefs" />);
    expect(probe('primary')).toBe('plus-briefs');
    await mount(null);
    expect(probe('sort')).toBe('');
    expect(probe('primary')).toBe('');
  });

  it('outside the provider the hook is a no-op', () => {
    expect(() => renderToStaticMarkup(<Page label="alone" />)).not.toThrow();
  });

  it('pure: no fetch, no await, no rpc in the module', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./topbar-actions.tsx', import.meta.url)),
      'utf8',
    );
    expect(src).not.toMatch(/\bawait\b|fetchWithTrace|callRpc|supabase/);
  });

  it('TopbarPlus: filled icon-only primary with the old label and induction key', () => {
    const html = renderToStaticMarkup(
      <TopbarPlus label="New post" induction="pipeline-new-post" onClick={() => {}} />,
    );
    expect(html).toContain('aria-label="New post"');
    expect(html).toContain('data-induction="pipeline-new-post"');
    expect(html).toContain('data-topbar-plus=""');
    expect(html).toContain('h-11');
    expect(html).not.toContain('>New post<');
  });
});

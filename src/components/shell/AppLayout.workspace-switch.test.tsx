// @vitest-environment jsdom
// Workspace switch is a clean cut: AppLayout keys the route Outlet by the active
// workspace id, so a switch remounts the page and no state from workspace A
// stays on screen under B. AppLayout itself is impractical to mount (see
// AppLayout.test.tsx), so this asserts the source keeps the key and runs the
// same keyed Outlet under a real router with a stateful page.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = readFileSync(fileURLToPath(new URL('./AppLayout.tsx', import.meta.url)), 'utf8');

/** A page that holds the workspace it first mounted under (like a page's items). */
function Page({ workspaceId }: { workspaceId: string }): ReactElement {
  const [shownFor] = useState(workspaceId);
  return <p data-page="">{`items of ${shownFor}`}</p>;
}

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function render(workspaceId: string): void {
  const Shell = (): ReactElement => <Outlet key={workspaceId} />;
  act(() => {
    root?.render(
      <MemoryRouter initialEntries={['/assets']}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="/assets" element={<Page workspaceId={workspaceId} />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
  });
}

describe('AppLayout workspace switch', () => {
  it('keys the Outlet by the active workspace and keeps the switch hold', () => {
    expect(source).toContain("<Outlet key={workspaceId ?? 'none'} />");
    expect(source).toContain('switchPending ? null :');
  });

  it("a page's state from workspace A is not visible after switching to B", () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    render('A');
    expect(document.querySelector('[data-page]')?.textContent).toBe('items of A');
    render('B');
    expect(document.querySelector('[data-page]')?.textContent).toBe('items of B');
    expect(document.body.textContent).not.toContain('items of A');
  });
});

// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installDomMutationGuard } from '@/lib/dom-mutation-guard';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { warn, error: vi.fn() } }));

describe('installDomMutationGuard', () => {
  beforeAll(() => {
    installDomMutationGuard();
  });

  it('removeChild on a non-child returns the node without throwing', async () => {
    const parent = document.createElement('div');
    const stranger = document.createTextNode('moved by translate');
    expect(parent.removeChild(stranger)).toBe(stranger);
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('dom: foreign node mutation', { op: 'removeChild' });
    });
  });

  it('insertBefore with a foreign reference node inserts at the end', () => {
    const parent = document.createElement('div');
    const first = parent.appendChild(document.createElement('span'));
    const foreign = document.createElement('i');
    const node = document.createElement('b');
    expect(parent.insertBefore(node, foreign)).toBe(node);
    expect(Array.from(parent.childNodes)).toEqual([first, node]);
  });

  it('warns once per page load', async () => {
    const parent = document.createElement('div');
    parent.removeChild(document.createTextNode('a'));
    parent.insertBefore(document.createElement('b'), document.createElement('i'));
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('leaves normal calls unchanged', () => {
    const parent = document.createElement('div');
    const a = parent.appendChild(document.createElement('a'));
    const b = document.createElement('b');
    expect(parent.insertBefore(b, a)).toBe(b);
    expect(Array.from(parent.childNodes)).toEqual([b, a]);
    const c = document.createElement('i');
    expect(parent.insertBefore(c, null)).toBe(c);
    expect(Array.from(parent.childNodes)).toEqual([b, a, c]);
    expect(parent.removeChild(a)).toBe(a);
    expect(a.parentNode).toBeNull();
    expect(Array.from(parent.childNodes)).toEqual([b, c]);
  });

  it('a second install is a no-op', () => {
    const remove = Node.prototype.removeChild;
    const insert = Node.prototype.insertBefore;
    installDomMutationGuard();
    expect(Node.prototype.removeChild).toBe(remove);
    expect(Node.prototype.insertBefore).toBe(insert);
  });
});

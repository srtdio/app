// @vitest-environment jsdom
// The concept screen's link to a post: the status box's Post row ("Not made
// yet", "Not ready to view yet", or the post's title and stage, which opens
// it); the agency's Link a post / Change linked post / Unlink post buttons
// (on any concept, OK'd or not; clients never see them); the link picker in
// link mode with the concept's day; and the write (plan_concept_link_post with
// a fresh trace id, then the plan re-read; refusals as toasts).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { LinkActions, PostStatusRow, linkViewOf } from '@/components/chat/PlanItemScreen';
import {
  CHANGE_LINKED_POST_LABEL,
  DRAFT_NOT_READY,
  LINK_POST_LABEL,
  POST_NOT_MADE_LABEL,
  UNLINK_POST_LABEL,
  canLinkPost,
} from '@/components/chat/plan-card';
import type { PlanItemRow } from '@/lib/chat/plans';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom's import.meta.url is not a file URL: read from the repo root.
const source = (): string =>
  readFileSync(join(process.cwd(), 'src/components/chat/PlanItemScreen.tsx'), 'utf8');
const between = (src: string, from: string, to: string): string =>
  src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function mount(node: React.ReactElement): void {
  act(() => {
    root = createRoot(host!);
    root.render(node);
  });
}

function buttons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button')];
}

const concept: PlanItemRow = {
  id: 'c1',
  plan_id: 'plan',
  kind: 'concept',
  position: 0,
  title: 'Farmers',
  description: null,
  post_id: null,
  created_at: '2026-11-01T00:00:00Z',
  target_date: '2026-11-06',
};

describe('the Link button shows for the agency on any concept', () => {
  it('canLinkPost gates it; LinkActions renders nothing without it', () => {
    expect(canLinkPost(concept, 'agency')).toBe(true);
    expect(canLinkPost(concept, 'client')).toBe(false);
    mount(
      <LinkActions
        linked={false}
        mayLink={false}
        busy={false}
        onLink={vi.fn()}
        onUnlink={vi.fn()}
      />,
    );
    expect(buttons()).toHaveLength(0);
  });

  it('an unlinked concept shows one secondary "Link a post" with the link icon', () => {
    const onLink = vi.fn();
    mount(<LinkActions linked={false} mayLink busy={false} onLink={onLink} onUnlink={vi.fn()} />);
    const [link] = buttons();
    expect(buttons()).toHaveLength(1);
    expect(link?.textContent).toBe(LINK_POST_LABEL);
    expect(link?.className).toContain('lit-btn-secondary');
    expect(link?.querySelector('svg')).not.toBeNull();
    act(() => link?.click());
    expect(onLink).toHaveBeenCalledTimes(1);
  });

  it('the screen renders the buttons for the agency side only, never for a client', () => {
    const src = source();
    expect(src).toMatch(/\{side === 'agency' \? \(\s*<LinkActions/);
    expect(src).toContain('mayLink={mayLink}');
    expect(src).toContain('const mayLink = canLinkPost(item, side);');
    // The picker mounts for the agency on a concept only, in link mode.
    const picker = between(src, '<PostPicker', '/>');
    expect(src).toMatch(/side === 'agency' && item\.kind === 'concept' \? \(\s*<PostPicker/);
    expect(picker).toContain('mode="link"');
    expect(picker).toContain('linkDay={item.target_date?.slice(0, 10) ?? null}');
    expect(picker).toContain('linkSelectedId={linkPickId}');
    // Not in Edit concept: the sheet carries no link control.
    expect(between(src, '<ConceptSheet', '/>')).not.toContain('link');
  });
});

describe('Change and Unlink', () => {
  it('a linked, approved concept shows "Change linked post" and "Unlink post"', () => {
    const onLink = vi.fn();
    const onUnlink = vi.fn();
    mount(<LinkActions linked mayLink busy={false} onLink={onLink} onUnlink={onUnlink} />);
    expect(buttons().map((b) => b.textContent)).toEqual([
      CHANGE_LINKED_POST_LABEL,
      UNLINK_POST_LABEL,
    ]);
    for (const b of buttons()) expect(b.className).toContain('lit-btn-secondary');
    act(() => buttons()[0]?.click());
    act(() => buttons()[1]?.click());
    expect(onLink).toHaveBeenCalledTimes(1);
    expect(onUnlink).toHaveBeenCalledTimes(1);
  });

  it('a linked concept that lost its approval keeps Unlink only', () => {
    mount(<LinkActions linked mayLink={false} busy={false} onLink={vi.fn()} onUnlink={vi.fn()} />);
    expect(buttons().map((b) => b.textContent)).toEqual([UNLINK_POST_LABEL]);
  });

  it('Change opens the picker on the current post; confirming the same post is a no-op', () => {
    const src = source();
    const open = between(src, 'const openLinkPicker', 'const writeLink');
    expect(open).toContain('setLinkPickId(linkedId);');
    const confirm = between(src, 'const confirmLink', 'const openLinked');
    expect(confirm).toContain('if (pick === null || pick.id === linkedId) return;');
  });

  it('the write: plan_concept_link_post with a fresh trace id, null to unlink, then the re-read', () => {
    const write = between(source(), 'const writeLink', 'const confirmLink');
    expect(write).toContain('const traceId = generateTraceId();');
    expect(write).toContain('p_post_id: post?.id ?? null,');
    expect(write).toContain('p_trace_id: traceId,');
    expect(write).toMatch(
      /toast\.show\(\{\s*title: linkErrorCopy\(result\.error\.message, CONCEPT_SAVE_FAILED\),\s*tone: 'error',?\s*\}\)/,
    );
    expect(write).toContain('planChanged();');
    // Unlink takes effect at once: no confirm dialog.
    expect(source()).toContain('onUnlink={() => void writeLink(null)}');
  });

  it("the screen's own write shows at once over the read", () => {
    expect(linkViewOf({ kind: 'none' }, undefined)).toEqual({ kind: 'none' });
    expect(linkViewOf({ kind: 'none' }, null)).toEqual({ kind: 'none' });
    expect(
      linkViewOf(
        { kind: 'none' },
        { id: 'pB', title: 'Bhai Dooj', platform: 'linkedin', format: 'text', stage: 'approved' },
      ),
    ).toEqual({
      kind: 'linked',
      postId: 'pB',
      stage: 'approved',
      info: { title: 'Bhai Dooj', format: 'text' },
    });
  });
});

describe('the status box Post row', () => {
  it('unlinked reads "Not made yet"; a client-hidden post "Not ready to view yet"; neither opens', () => {
    mount(<PostStatusRow link={{ kind: 'none' }} onOpen={vi.fn()} />);
    expect(document.body.textContent).toBe(`Post${POST_NOT_MADE_LABEL}`);
    expect(buttons()).toHaveLength(0);
    act(() => root?.unmount());
    mount(<PostStatusRow link={{ kind: 'hidden', postId: 'pA' }} onOpen={vi.fn()} />);
    expect(document.body.textContent).toBe(`Post${DRAFT_NOT_READY}`);
    expect(buttons()).toHaveLength(0);
  });

  it('linked shows the title and the POST line stage ("Review", never "In review") and opens the post', () => {
    const onOpen = vi.fn();
    mount(
      <PostStatusRow
        link={{
          kind: 'linked',
          postId: 'pA',
          stage: 'review',
          info: { title: 'Farmers post', format: 'text' },
        }}
        onOpen={onOpen}
      />,
    );
    const [row] = buttons();
    expect(row?.textContent).toContain('Farmers post');
    expect(row?.textContent).toContain('Review');
    expect(row?.textContent).not.toContain('In review');
    act(() => row?.click());
    expect(onOpen).toHaveBeenCalledWith('pA');
  });
});

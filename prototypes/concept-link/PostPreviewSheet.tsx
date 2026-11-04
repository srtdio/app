// Mock post preview: what tapping a paired post row (or the concept's Post
// row) opens in this prototype. Title, stage tag, due date, a caption
// placeholder, Close. A draft seen by a client shows one line only.

import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { Tag } from '@/components/ui/Tag';
import type { FixturePost, Viewer } from './fixtures';
import { DRAFT_NOT_READY, SECTION_LABEL, dueShort, postLine } from './shared';

export function PostPreviewSheet(props: {
  post: FixturePost | null;
  viewer: Viewer;
  onClose: () => void;
}): ReactElement {
  const { post } = props;
  const locked = post !== null && props.viewer === 'client' && post.stage === 'draft';
  return (
    <Sheet
      open={post !== null}
      onClose={props.onClose}
      title="Post"
      footer={
        <Button data-proto-preview-close="" onClick={props.onClose} className="ml-auto">
          Close
        </Button>
      }
    >
      {post === null ? null : locked ? (
        <p data-proto-preview="" className="text-base text-fg-2">
          {DRAFT_NOT_READY}
        </p>
      ) : (
        <div data-proto-preview="" className="flex flex-col gap-3">
          <h3 className="break-words text-lg font-semibold text-fg">{post.title}</h3>
          <div className="flex items-center gap-2">
            <Tag label={postLine(post.stage).label} dot={post.stage} />
            <span className="text-sm text-fg-2">{post.format}</span>
          </div>
          <div className="flex min-h-[28px] items-center justify-between gap-2 rounded-lg border bg-panel p-3 lit-card">
            <span className="text-base text-fg-3">Due date</span>
            <span className="font-mono text-md tabular-nums text-fg-2">
              {dueShort(post.dueDate)}
            </span>
          </div>
          <section className="flex flex-col gap-2">
            <h4 className={SECTION_LABEL}>Caption</h4>
            <p className="rounded-lg border bg-panel-2 p-3 text-base text-fg-2 lit-card-muted">
              {post.caption}
            </p>
          </section>
        </div>
      )}
    </Sheet>
  );
}

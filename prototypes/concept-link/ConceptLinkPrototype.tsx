// Prototype: link an existing post to an approved plan concept. In-memory
// only: the one state that changes is conceptId -> postId | null. Linking or
// unlinking never changes a concept's PLAN, its comments or a post's stage,
// never creates a post and never asks anyone to approve a post's plan slot.
// Flow: the Plan list -> tap the concept row -> the concept screen -> Link a
// post -> the picker. The plan then shows the concept and its post as a pair.

import { useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { CONCEPT_FARMERS, INITIAL_LINKS, ITEMS, POSTS, postById } from './fixtures';
import type { FixtureConcept, LinkState, Viewer } from './fixtures';
import { ConceptScreen } from './ConceptScreen';
import { LinkPostPicker } from './LinkPostPicker';
import { PlanList } from './PlanList';
import { PostPreviewSheet } from './PostPreviewSheet';
import { SECTION_LABEL, planText, postLine, useLaptop } from './shared';

export function ConceptLinkPrototype(): ReactElement {
  const laptop = useLaptop();
  const [viewer, setViewer] = useState<Viewer>('agency');
  const [links, setLinks] = useState<LinkState>(INITIAL_LINKS);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const concept: FixtureConcept | null =
    ITEMS.find((i): i is FixtureConcept => i.kind === 'concept' && i.id === openId) ?? null;
  const linkedId = concept !== null ? (links[concept.id] ?? null) : null;

  const link = (postId: string): void => {
    setPickerOpen(false);
    // Linking the same post again is a no-op.
    if (concept === null || postId === linkedId) return;
    const id = concept.id;
    setLinks((prev) => ({ ...prev, [id]: postId }));
  };
  const unlink = (): void => {
    if (concept === null) return;
    const id = concept.id;
    setLinks((prev) => ({ ...prev, [id]: null }));
  };
  const farmersLink = postById(links[CONCEPT_FARMERS.id] ?? null);

  return (
    <div className="min-h-[100svh] bg-bg text-fg">
      <div className={cn('flex flex-col', laptop && concept !== null && 'pr-[440px]')}>
        <div className={cn('flex w-full flex-col', laptop && 'mx-auto max-w-[600px] py-6')}>
          {/* Prototype only: the viewer switch. */}
          <div
            data-proto-viewer=""
            className={cn(
              'flex items-center gap-2 border-b border-dashed border-border-strong px-4 py-2',
              laptop && 'mb-4 rounded-lg border',
            )}
          >
            <span className={cn(SECTION_LABEL, 'mr-auto')}>Prototype viewer</span>
            {(['agency', 'client'] as const).map((v) => (
              <Button
                key={v}
                variant={viewer === v ? 'primary' : 'secondary'}
                aria-pressed={viewer === v}
                data-proto-viewer-pick={v}
                onClick={() => setViewer(v)}
              >
                {v === 'agency' ? 'Agency' : 'Client'}
              </Button>
            ))}
          </div>
          <div className={cn(laptop && 'overflow-hidden rounded-xl border bg-panel lit-overlay')}>
            <PlanList
              links={links}
              viewer={viewer}
              laptop={laptop}
              openId={openId}
              onOpenConcept={setOpenId}
              onOpenPost={setPreviewId}
            />
          </div>
          <aside
            data-proto-state=""
            className="mx-4 mb-6 mt-4 flex flex-col gap-1 rounded-lg border border-dashed border-border-strong p-3 text-sm text-fg-2 md:mx-0"
          >
            <span className={SECTION_LABEL}>Prototype state (prototype only)</span>
            <span>
              Linked post:{' '}
              <span className="text-fg">{farmersLink !== null ? farmersLink.title : 'none'}</span>
            </span>
            <span>
              Concept PLAN: <span className="text-fg">{planText(CONCEPT_FARMERS.plan)}</span> ·
              Comments:{' '}
              <span className="font-mono tabular-nums text-fg">
                {CONCEPT_FARMERS.comments.length}
              </span>{' '}
              · Posts: <span className="font-mono tabular-nums text-fg">{POSTS.length}</span>
            </span>
            <span>
              Post stages:{' '}
              <span className="text-fg">
                {POSTS.map((p) => `${p.id.slice(-1).toUpperCase()} ${postLine(p.stage).label}`).join(
                  ', ',
                )}
              </span>
            </span>
          </aside>
        </div>
      </div>

      {concept !== null ? (
        <ConceptScreen
          concept={concept}
          linked={postById(linkedId)}
          viewer={viewer}
          laptop={laptop}
          onBack={() => setOpenId(null)}
          onLink={() => setPickerOpen(true)}
          onUnlink={unlink}
          onOpenPost={() => setPreviewId(linkedId)}
        />
      ) : null}

      <LinkPostPicker
        open={pickerOpen}
        current={linkedId}
        conceptDate={concept?.day ?? CONCEPT_FARMERS.day}
        onLink={link}
        onClose={() => setPickerOpen(false)}
      />
      <PostPreviewSheet
        post={postById(previewId)}
        viewer={viewer}
        onClose={() => setPreviewId(null)}
      />
    </div>
  );
}

import { useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { Textarea } from '@/components/ui/Textarea';
import { RowSend, WritingBox } from '@/components/ui/WritingBox';
import { ICON_SIZE, IconSend } from '@/components/ui/icons';
import { INDUCTION_KEYS } from '@/lib/induction-keys';
import { errorText } from '@/lib/error-copy';

// F4 caption annotation composer: a bottom sheet that shows the quoted caption
// selection and a comment field. It owns no RPC; PostDetailPage passes onSubmit,
// which mints the comment and the annotation. The quote is the ink rail
// (border-l-rail fg) the comment row's quote chip uses, so light and dark match.
//
// The draft is owned by the page (one per selection, kept while the page is
// open), so this sheet is controlled. Typed text makes the sheet dirty: X,
// backdrop and Escape ask before discarding it. Cancel closes and keeps the
// draft for the same selection. The sheet stays open while posting and after a
// failure (text kept, error shown); the page closes it once the comment lands.

/** Discard confirm copy for both annotation composers. */
export const COMMENT_DISCARD = {
  title: 'Discard this comment?',
  message: 'Your text will be lost.',
};

/** Failure copy for both annotation composers; the typed text stays. */
export const COMMENT_POST_FAILED = errorText('post your comment', null);

/** The sheet's title, also the writing box's expanded title. */
const SHEET_TITLE = 'Comment on caption';

interface CaptionAnnotationComposerProps {
  open: boolean;
  /** The selected caption text, shown as the note the comment is anchored to. */
  quote: string;
  /** The draft for this selection (page-owned). */
  body: string;
  onBodyChange: (body: string) => void;
  /** Cancel: close and keep the draft for this selection. */
  onCancel: () => void;
  /** Close after the discard confirm (or with nothing typed): drop the draft. */
  onDiscard: () => void;
  onSubmit: (body: string) => void | Promise<void>;
  submitting?: boolean;
  /** Inline failure, shown under the field; null shows none. */
  error?: string | null;
}

export function CaptionAnnotationComposer({
  open,
  quote,
  body,
  onBodyChange,
  onCancel,
  onDiscard,
  onSubmit,
  submitting = false,
  error = null,
}: CaptionAnnotationComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canPost = body.trim().length > 0 && !submitting;

  return (
    <Sheet
      open={open}
      onClose={onDiscard}
      title={SHEET_TITLE}
      dirty={body.trim() !== ''}
      discard={COMMENT_DISCARD}
      busy={submitting}
      footer={
        <Button variant="ghost" disabled={submitting} onClick={onCancel}>
          Cancel
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="min-w-0 border-l-rail border-fg pl-3 text-base text-fg-2 [overflow-wrap:anywhere]">
          {quote}
        </div>
        {/* ui/WritingBox (comment mode): text on top; focused, the row
            under it: Aa, emoji ... the round Post (no +, no @ here). */}
        <WritingBox
          mode="comment"
          field={() => textareaRef.current}
          hasText={body.trim() !== ''}
          expandTitle={SHEET_TITLE}
          input={
            <Textarea
              formatting
              ref={textareaRef}
              value={body}
              onChange={(event) => onBodyChange(event.target.value)}
              placeholder="Add your comment"
              aria-label="Caption comment body"
              disabled={submitting}
              autoFocus
            />
          }
          send={
            <RowSend
              type="button"
              label="Post"
              icon={<IconSend size={ICON_SIZE.control} />}
              data-induction={INDUCTION_KEYS.postCommentPost}
              busy={submitting}
              disabled={!canPost}
              onClick={() => void onSubmit(body)}
            />
          }
        />
        {error !== null ? (
          <p role="alert" className="text-base text-bad">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}

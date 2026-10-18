import { useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { Textarea } from '@/components/ui/Textarea';
import { CommentEmojiButton, insertIntoTextarea } from '@/components/comments/CommentEmojiButton';
import { INDUCTION_KEYS } from '@/lib/induction-keys';

// F4 caption annotation composer: a bottom sheet that shows the quoted caption
// selection and a comment field. It owns no RPC; PostDetailPage passes onSubmit,
// which mints the comment and the annotation. Amber accent is the F1 annotation
// token, so the note block flips correctly in light and dark.
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
export const COMMENT_POST_FAILED = "Couldn't post your comment. Try again.";

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
      title="Comment on caption"
      dirty={body.trim() !== ''}
      discard={COMMENT_DISCARD}
      busy={submitting}
      busyLabel="Posting…"
      footer={
        <>
          <Button
            size="lg"
            className="min-h-[44px] min-w-[44px]"
            disabled={submitting}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <CommentEmojiButton
            disabled={submitting}
            onPick={(char) =>
              insertIntoTextarea(() => textareaRef.current, body, char, onBodyChange)
            }
          />
          <Button
            size="lg"
            variant="primary"
            className="ml-auto min-h-[44px] min-w-[44px]"
            data-induction={INDUCTION_KEYS.postCommentPost}
            disabled={!canPost}
            onClick={() => void onSubmit(body)}
          >
            {submitting ? 'Posting' : 'Post'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-md border-l-4 border-annotation-line bg-annotation-bg px-3 py-2 text-sm text-fg">
          {quote}
        </div>
        <Textarea
          ref={textareaRef}
          value={body}
          onChange={(event) => onBodyChange(event.target.value)}
          placeholder="Add your comment"
          aria-label="Caption comment body"
          disabled={submitting}
          autoFocus
        />
        {error !== null ? (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}

import { useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { Textarea } from '@/components/ui/Textarea';
import { CommentEmojiButton, insertIntoTextarea } from '@/components/comments/CommentEmojiButton';
import { COMMENT_DISCARD } from '@/components/pages/pcs/CaptionAnnotationComposer';

// F5 image-pin composer: the sibling of the F4 caption composer, pin-worded. It
// shows the slide the pin landed on (filename or "Slide N") instead of a caption
// quote, and owns no RPC. PostDetailPage passes onSubmit, which mints the comment
// and the image_pin annotation on one trace. Amber accent is the F1 annotation
// token, so the context block flips correctly in light and dark. Draft, dirty,
// busy and failure handling match the caption composer.

interface PinAnnotationComposerProps {
  open: boolean;
  /** The slide the pin is anchored to (filename or "Slide N"). */
  context: string;
  /** The draft for this pin (page-owned). */
  body: string;
  onBodyChange: (body: string) => void;
  /** Cancel: close and keep the draft for this pin. */
  onCancel: () => void;
  /** Close after the discard confirm (or with nothing typed): drop the draft. */
  onDiscard: () => void;
  onSubmit: (body: string) => void | Promise<void>;
  submitting?: boolean;
  /** Inline failure, shown under the field; null shows none. */
  error?: string | null;
}

export function PinAnnotationComposer({
  open,
  context,
  body,
  onBodyChange,
  onCancel,
  onDiscard,
  onSubmit,
  submitting = false,
  error = null,
}: PinAnnotationComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canPost = body.trim().length > 0 && !submitting;

  return (
    <Sheet
      open={open}
      onClose={onDiscard}
      title="Comment on image"
      dirty={body.trim() !== ''}
      discard={COMMENT_DISCARD}
      busy={submitting}
      busyLabel="Posting…"
      footer={
        <>
          <Button
           
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
            variant="primary"
            className="ml-auto"
            disabled={!canPost}
            onClick={() => void onSubmit(body)}
          >
            {submitting ? 'Posting…' : 'Post'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-md border-l-4 border-annotation-line bg-annotation-bg px-3 py-2 text-sm text-fg">
          {context}
        </div>
        <Textarea
          ref={textareaRef}
          value={body}
          onChange={(event) => onBodyChange(event.target.value)}
          placeholder="Add your comment"
          aria-label="Image comment body"
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

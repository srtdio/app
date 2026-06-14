import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { Textarea } from '@/components/ui/Textarea';

// F4 caption annotation composer: a bottom sheet that shows the quoted caption
// selection and a comment field. It owns no RPC; PostDetailPage passes onSubmit,
// which mints the comment and the annotation. Amber accent is the F1 annotation
// token, so the note block flips correctly in light and dark.

interface CaptionAnnotationComposerProps {
  open: boolean;
  /** The selected caption text, shown as the note the comment is anchored to. */
  quote: string;
  onClose: () => void;
  onSubmit: (body: string) => void | Promise<void>;
  submitting?: boolean;
}

export function CaptionAnnotationComposer({
  open,
  quote,
  onClose,
  onSubmit,
  submitting = false,
}: CaptionAnnotationComposerProps) {
  const [body, setBody] = useState('');

  // Start each annotation from an empty field so a prior draft never leaks into
  // the next selection.
  useEffect(() => {
    if (open) setBody('');
  }, [open]);

  const canPost = body.trim().length > 0 && !submitting;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Comment on caption"
      footer={
        <>
          <Button
            size="lg"
            className="min-h-[44px] min-w-[44px]"
            disabled={submitting}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            size="lg"
            variant="primary"
            className="ml-auto min-h-[44px] min-w-[44px]"
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
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Add your comment"
          aria-label="Caption comment body"
          disabled={submitting}
          autoFocus
        />
      </div>
    </Sheet>
  );
}
